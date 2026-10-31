import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { and, eq, sql } from "drizzle-orm";
import { auditLog, db, moOperationScrap, permissionGroups, stockTransactions, timeReports } from "@navet/db";
import { buildApp } from "../src/app.js";
import { createAuthService } from "../src/modules/auth/service/auth.service.js";
import { testArticleService, testDocumentPdfService } from "./helpers/services.js";
import { createArticleRepository } from "../src/modules/article/repository/article.repository.js";
import { createArticleService } from "../src/modules/article/service/article.service.js";
import { createAuthRepository } from "../src/modules/auth/repository/auth.repository.js";
import { createManufacturingRepository } from "../src/modules/manufacturing/repository/manufacturing.repository.js";
import {
  createManufacturingService,
  ManufacturingOrderHasReportsError,
  ManufacturingOrderStampedInError,
  MoReportAlreadyUndoneError,
  MoReportFromPurchaseReceiptError,
  MoReportNotFoundError,
  MoReportStockMissingError,
  MoReportTimeLockedError,
} from "../src/modules/manufacturing/service/manufacturing.service.js";
import { createTimeReportRepository } from "../src/modules/timereport/repository/timereport.repository.js";
import { createTimeReportService } from "../src/modules/timereport/service/timereport.service.js";
import { createStockRepository } from "../src/modules/stock/repository/stock.repository.js";
import { createStockService } from "../src/modules/stock/service/stock.service.js";
import { createAuditRepository } from "../src/modules/system/repository/audit.repository.js";

// Ångra rapportering: every reporting event on a TO is logged in mo_reports
// with exactly what it booked, and undoing one reverses precisely that —
// quantities, scrap rows, material, finished goods, the stamp's time report
// and the order's status.

let lockedDates = new Set<string>();
const periodLocks = { isDateLocked: async (date: string) => lockedDates.has(date) };
const articleService = createArticleService(createArticleRepository(db));
const stockService = createStockService(createStockRepository(db));
const authRepo = createAuthRepository(db);
const mfgService = createManufacturingService(
  createManufacturingRepository(db),
  testDocumentPdfService,
  testArticleService,
  undefined as never,
  createAuditRepository(db),
  undefined,
  periodLocks
);
const timeReportService = createTimeReportService(createTimeReportRepository(db), mfgService, periodLocks, { log: async () => {} });

const TRUNCATE = sql`TRUNCATE mo_reports, mo_report_materials, attendance_sessions, stamp_sessions, time_reports, employees, mo_material_consumptions, mo_operations, manufacturing_orders, routing_operations, work_centers, production_groups, stock_transactions, stock_locations, warehouses, bom_components, articles, payroll_periods, audit_log, user_settings, users CASCADE`;
// Only the groups this file creates — the migration's seeded groups (ALLA,
// VERKSTAD) belong to other test files.
const DELETE_GROUPS = sql`DELETE FROM permission_groups WHERE code LIKE 'UNDO%'`;

beforeEach(async () => {
  lockedDates = new Set();
  await db.execute(TRUNCATE);
  await db.execute(DELETE_GROUPS);
});

afterAll(async () => {
  await db.execute(TRUNCATE);
  await db.execute(DELETE_GROUPS);
});

async function balance(articleId: string, locationId: string) {
  const [row] = await db
    .select({ q: sql<string>`coalesce(sum(${stockTransactions.quantityDelta}), 0)` })
    .from(stockTransactions)
    .where(and(eq(stockTransactions.articleId, articleId), eq(stockTransactions.locationId, locationId)));
  return Number(row!.q);
}

// A released TO for 5 st with two operations (10 and 20); the component
// (2 per unit) is linked to operation 10, and the article's own location is
// where both the component is drawn from and the finished goods land.
async function setup() {
  const user = await authRepo.create({
    email: `undo-${crypto.randomUUID()}@example.com`,
    passwordHash: "x",
    name: "Arbetsledare",
    role: "supervisor",
  });
  const warehouse = await stockService.createWarehouse({ name: "Huvudlager", active: true });
  const location = await stockService.createLocation({ warehouseId: warehouse.id, name: "A1", active: true });
  const component = await articleService.createArticle({
    articleNumber: `C-${crypto.randomUUID()}`,
    name: "Komponent",
    type: "purchased",
    unit: "st",
    defaultLocationId: location.id,
    active: true,
  });
  const parent = await articleService.createArticle({
    articleNumber: `P-${crypto.randomUUID()}`,
    name: "Produkt",
    type: "manufactured",
    unit: "st",
    defaultLocationId: location.id,
    active: true,
  });
  const workCenter = await mfgService.createWorkCenter({ code: "100", name: "Svets", active: true });
  const op10 = await mfgService.createRoutingOperation(parent.id, { sequenceNo: 10, workCenterId: workCenter.id, setupTime: 10, runTimePerUnit: 2 });
  await mfgService.createRoutingOperation(parent.id, { sequenceNo: 20, workCenterId: workCenter.id, setupTime: 5, runTimePerUnit: 1 });
  await articleService.addBomComponent(parent.id, { componentArticleId: component.id, quantity: 2, routingOperationId: op10.id });
  await stockService.recordTransaction({ articleId: component.id, locationId: location.id, quantityDelta: 100, transactionType: "inventory_adjustment" });
  const order = await mfgService.createManufacturingOrder({ articleId: parent.id, quantity: 5 }, user.id);
  const [first, last] = (await mfgService.listOperations(order.id)).sort((a, b) => a.sequenceNo - b.sequenceNo);
  const employee = await timeReportService.createEmployee({ employeeNumber: "107", name: "Urban", active: true });
  return { user, location, component, parent, order, first: first!, last: last!, employee };
}

async function orderNow(id: string) {
  return (await mfgService.getManufacturingOrder(id))!;
}

async function stampOut(ctx: Awaited<ReturnType<typeof setup>>, operationId: string, input: object) {
  const session = await timeReportService.stampIn({ employeeId: ctx.employee.id, moOperationId: operationId }, ctx.user.id);
  return timeReportService.stampOut(session.id, input, ctx.user.id);
}

describe("report log", () => {
  it("logs every stamp-out (also 0/0), Slutför operation, a manual draw and Slutför order", async () => {
    const ctx = await setup();
    await stampOut(ctx, ctx.first.id, {});
    await stampOut(ctx, ctx.first.id, { quantityOk: 2, quantityScrapped: 1, scrapReason: "Repa" });
    await mfgService.completeOperation(ctx.last.id, { quantityCompleted: 1 }, ctx.user.id);
    const [material] = await mfgService.listMaterialConsumptions(ctx.order.id);
    await mfgService.consumeMaterial(ctx.order.id, material!.id, { quantity: 1 }, ctx.user.id);
    await mfgService.complete(ctx.order.id, { quantity: 0 }, ctx.user.id);

    const reports = await mfgService.listReports(ctx.order.id);
    expect(
      reports
        .map((r) => [r.kind, r.source, r.sequenceNo, Number(r.quantityOk), Number(r.quantityScrapped), Number(r.quantityReceived), r.completedOrder])
        .reverse()
    ).toEqual([
      ["operation", "terminal", 10, 0, 0, 0, false],
      ["operation", "terminal", 10, 2, 1, 0, false],
      ["operation", "card", 20, 1, 0, 1, false],
      ["material", "card", null, 0, 0, 0, false],
      ["completion", "card", null, 0, 0, 0, true],
    ]);
    // The stamp's hours and who did it ride along; the draw lists its material.
    expect(reports.at(-1)!.employeeName).toBe("Urban");
    expect(Number(reports.at(-1)!.hours)).toBeGreaterThan(0);
    expect(reports.at(-2)!.materials.map((m) => Number(m.quantity))).toEqual([6]); // (2 OK + 1 kasserat) × 2
    expect(reports.find((r) => r.kind === "material")!.materials.map((m) => Number(m.quantity))).toEqual([1]);
  });
});

describe("Ångra rapportering", () => {
  it("reverses a stamp-out exactly: quantities, scrap row, material back to its location and the time report", async () => {
    const ctx = await setup();
    await stampOut(ctx, ctx.first.id, { quantityOk: 2, quantityScrapped: 1, scrapReason: "Repa" });
    expect(await balance(ctx.component.id, ctx.location.id)).toBe(94);
    const [report] = await mfgService.listReports(ctx.order.id);

    await mfgService.undoReport(ctx.order.id, report!.id, ctx.user.id);

    const [op] = (await mfgService.listOperations(ctx.order.id)).sort((a, b) => a.sequenceNo - b.sequenceNo);
    expect([Number(op!.quantityCompleted), Number(op!.quantityScrapped), op!.status]).toEqual([0, 0, "pending"]);
    expect(await db.select().from(moOperationScrap)).toEqual([]);
    expect(await balance(ctx.component.id, ctx.location.id)).toBe(100);
    const [material] = await mfgService.listMaterialConsumptions(ctx.order.id);
    expect(Number(material!.quantityConsumed)).toBe(0);
    expect(await db.select().from(timeReports)).toEqual([]);

    const [undone] = await mfgService.listReports(ctx.order.id);
    expect(undone!.undoneAt).not.toBeNull();
    expect(undone!.undoneByName).toBe("Arbetsledare");
    const audit = await db.select().from(auditLog).where(eq(auditLog.action, "report_undone"));
    expect(audit.map((a) => a.entityId)).toEqual([ctx.order.orderNumber]);

    await expect(mfgService.undoReport(ctx.order.id, report!.id, ctx.user.id)).rejects.toThrow(MoReportAlreadyUndoneError);
  });

  it("undoing a time-only stamp removes its time report", async () => {
    const ctx = await setup();
    await stampOut(ctx, ctx.first.id, {});
    const [report] = await mfgService.listReports(ctx.order.id);
    await mfgService.undoReport(ctx.order.id, report!.id, ctx.user.id);
    expect(await db.select().from(timeReports)).toEqual([]);
  });

  it("takes the finished goods back out and reopens an order the last operation completed", async () => {
    const ctx = await setup();
    await mfgService.completeOperation(ctx.first.id, {}, ctx.user.id);
    await mfgService.completeOperation(ctx.last.id, {}, ctx.user.id);
    expect((await orderNow(ctx.order.id)).status).toBe("done");
    expect(await balance(ctx.parent.id, ctx.location.id)).toBe(5);

    const lastReport = (await mfgService.listReports(ctx.order.id)).find((r) => r.sequenceNo === 20)!;
    await mfgService.undoReport(ctx.order.id, lastReport.id, ctx.user.id);

    const order = await orderNow(ctx.order.id);
    expect([order.status, Number(order.quantityReceived)]).toEqual(["in_progress", 0]);
    expect(await balance(ctx.parent.id, ctx.location.id)).toBe(0);
    const last = (await mfgService.listOperations(ctx.order.id)).find((o) => o.sequenceNo === 20)!;
    expect([last.status, Number(last.quantityCompleted)]).toEqual(["pending", 0]);
  });

  it("undoes an efterrapport on a done order and leaves the order done", async () => {
    const ctx = await setup();
    await mfgService.completeOperation(ctx.last.id, {}, ctx.user.id);
    await mfgService.completeOperation(ctx.first.id, {}, ctx.user.id);
    expect(await balance(ctx.component.id, ctx.location.id)).toBe(90);

    const late = (await mfgService.listReports(ctx.order.id)).find((r) => r.sequenceNo === 10)!;
    expect(Number(late.quantityReceived)).toBe(0);
    await mfgService.undoReport(ctx.order.id, late.id, ctx.user.id);

    expect(await balance(ctx.component.id, ctx.location.id)).toBe(100);
    const first = (await mfgService.listOperations(ctx.order.id)).find((o) => o.sequenceNo === 10)!;
    expect([first.status, Number(first.quantityCompleted)]).toEqual(["pending", 0]);
    const order = await orderNow(ctx.order.id);
    expect([order.status, Number(order.quantityReceived)]).toEqual(["done", 5]);
  });

  it("refuses when the received goods are no longer on the location", async () => {
    const ctx = await setup();
    await mfgService.completeOperation(ctx.last.id, { quantityCompleted: 3 }, ctx.user.id);
    await stockService.recordTransaction({ articleId: ctx.parent.id, locationId: ctx.location.id, quantityDelta: -2, transactionType: "inventory_adjustment" });
    const [report] = await mfgService.listReports(ctx.order.id);

    const err = await mfgService.undoReport(ctx.order.id, report!.id, ctx.user.id).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(MoReportStockMissingError);
    expect([(err as MoReportStockMissingError).available, (err as MoReportStockMissingError).required]).toEqual([1, 3]);
    // Nothing moved.
    expect(Number((await orderNow(ctx.order.id)).quantityReceived)).toBe(3);
  });

  it("reopens an order closed short with Slutför order 0", async () => {
    const ctx = await setup();
    await mfgService.complete(ctx.order.id, { quantity: 0 }, ctx.user.id);
    expect((await orderNow(ctx.order.id)).status).toBe("done");

    const [completion] = await mfgService.listReports(ctx.order.id);
    await mfgService.undoReport(ctx.order.id, completion!.id, ctx.user.id);
    expect((await orderNow(ctx.order.id)).status).toBe("released");
  });

  it("returns exactly a manual draw, leaving what a report drew", async () => {
    const ctx = await setup();
    await stampOut(ctx, ctx.first.id, { quantityOk: 1 });
    const [material] = await mfgService.listMaterialConsumptions(ctx.order.id);
    await mfgService.consumeMaterial(ctx.order.id, material!.id, { quantity: 3 }, ctx.user.id);
    expect(await balance(ctx.component.id, ctx.location.id)).toBe(95);

    const manual = (await mfgService.listReports(ctx.order.id)).find((r) => r.kind === "material")!;
    await mfgService.undoReport(ctx.order.id, manual.id, ctx.user.id);
    expect(await balance(ctx.component.id, ctx.location.id)).toBe(98);
    const [after] = await mfgService.listMaterialConsumptions(ctx.order.id);
    expect(Number(after!.quantityConsumed)).toBe(2);
  });

  it("refuses when the stamp's time lies in a locked payroll period", async () => {
    const ctx = await setup();
    const { timeReport } = await stampOut(ctx, ctx.first.id, { quantityOk: 1 });
    lockedDates.add(timeReport.date);
    const [report] = await mfgService.listReports(ctx.order.id);
    await expect(mfgService.undoReport(ctx.order.id, report!.id, ctx.user.id)).rejects.toThrow(MoReportTimeLockedError);
  });

  it("leaves a lego receipt's report to its IO", async () => {
    const ctx = await setup();
    await mfgService.reportOperationQuantities(ctx.first.id, {
      quantityOk: 1,
      quantityScrapped: 0,
      markDone: false,
      markDoneWhenCovered: true,
      createdBy: ctx.user.id,
      source: "purchase_receipt",
    });
    const [report] = await mfgService.listReports(ctx.order.id);
    await expect(mfgService.undoReport(ctx.order.id, report!.id, ctx.user.id)).rejects.toThrow(MoReportFromPurchaseReceiptError);
  });

  it("refuses a report from another order", async () => {
    const ctx = await setup();
    await stampOut(ctx, ctx.first.id, {});
    const [report] = await mfgService.listReports(ctx.order.id);
    const other = await mfgService.createManufacturingOrder({ articleId: ctx.parent.id, quantity: 1 }, ctx.user.id);
    await expect(mfgService.undoReport(other.id, report!.id, ctx.user.id)).rejects.toThrow(MoReportNotFoundError);
  });
});

describe("Makulera order", () => {
  it("is refused while a report stands, and allowed once it is undone", async () => {
    const ctx = await setup();
    await stampOut(ctx, ctx.first.id, { quantityOk: 1 });
    await expect(mfgService.cancel(ctx.order.id)).rejects.toThrow(ManufacturingOrderHasReportsError);

    const [report] = await mfgService.listReports(ctx.order.id);
    await mfgService.undoReport(ctx.order.id, report!.id, ctx.user.id);
    expect((await mfgService.cancel(ctx.order.id)).status).toBe("cancelled");
  });

  it("is not stopped by time-only stamps, but by someone stamped in", async () => {
    const ctx = await setup();
    await stampOut(ctx, ctx.first.id, {});
    await timeReportService.stampIn({ employeeId: ctx.employee.id, moOperationId: ctx.first.id }, ctx.user.id);
    await expect(mfgService.cancel(ctx.order.id)).rejects.toThrow(ManufacturingOrderStampedInError);

    const [open] = await timeReportService.listStampSessions(true);
    await timeReportService.stampOut(open!.id, {}, ctx.user.id);
    expect((await mfgService.cancel(ctx.order.id)).status).toBe("cancelled");
  });
});

// The undo removes a stamp's time report, so the route takes the same roles
// as deleting a time report: a user with Tillverkning but not arbetsledare
// is refused; the list itself is plain TO read.
describe("routes", () => {
  const app = buildApp();
  const authService = createAuthService(createAuthRepository(db), "unused", createAuditRepository(db));

  afterAll(async () => {
    await app.close();
  });

  async function session(role: "user" | "supervisor") {
    const [group] = await db
      .insert(permissionGroups)
      .values({ code: `UNDO${crypto.randomUUID().slice(0, 8)}`, name: "Tillverkning", permissions: ["tillverkning"] })
      .returning();
    const email = `r-${crypto.randomUUID()}@example.com`;
    await authService.createUser({ email, password: "correcthorse", name: "R", role, permissionGroupId: group!.id });
    const res = await app.inject({ method: "POST", url: "/api/v1/auth/login", payload: { email, password: "correcthorse" } });
    return `session=${res.cookies.find((c) => c.name === "session")!.value}`;
  }

  it("lists the reports and lets only admin/arbetsledare undo one", async () => {
    const ctx = await setup();
    await stampOut(ctx, ctx.first.id, { quantityOk: 1 });
    const [report] = await mfgService.listReports(ctx.order.id);
    const url = `/api/v1/manufacturing-orders/${ctx.order.id}/reports`;

    const user = await session("user");
    const list = await app.inject({ url, headers: { cookie: user } });
    expect([list.statusCode, list.json().length]).toEqual([200, 1]);
    const refused = await app.inject({ method: "POST", url: `${url}/${report!.id}/undo`, headers: { cookie: user } });
    expect(refused.statusCode).toBe(403);

    const supervisor = await session("supervisor");
    const undone = await app.inject({ method: "POST", url: `${url}/${report!.id}/undo`, headers: { cookie: supervisor } });
    expect(undone.statusCode).toBe(200);
    const again = await app.inject({ method: "POST", url: `${url}/${report!.id}/undo`, headers: { cookie: supervisor } });
    expect([again.statusCode, again.json().code]).toEqual([409, "mo-report-already-undone"]);
  });
});

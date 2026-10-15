import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { eq, sql } from "drizzle-orm";
import { db, stampSessions } from "@navet/db";
import { completeOperationSchema, stampOutSchema } from "@navet/shared";
import { testArticleService, testDocumentPdfService } from "./helpers/services.js";
import { createArticleRepository } from "../src/modules/article/repository/article.repository.js";
import { createArticleService } from "../src/modules/article/service/article.service.js";
import { createAuthRepository } from "../src/modules/auth/repository/auth.repository.js";
import { createManufacturingRepository } from "../src/modules/manufacturing/repository/manufacturing.repository.js";
import { createManufacturingService } from "../src/modules/manufacturing/service/manufacturing.service.js";
import { createTimeReportRepository } from "../src/modules/timereport/repository/timereport.repository.js";
import { createTimeReportService } from "../src/modules/timereport/service/timereport.service.js";

// Regel 10: an operation (or the whole order) turning done stamps out
// everyone still stamped in on it, inside the report's own transaction, and
// logs one undoable auto_close row per closed stamp.

const HOUR = 3_600_000;

const articleService = createArticleService(createArticleRepository(db));
const mfgRepo = createManufacturingRepository(db);
const mfgService = createManufacturingService(mfgRepo, testDocumentPdfService, testArticleService);
const authRepo = createAuthRepository(db);
const trRepo = createTimeReportRepository(db);
const trService = createTimeReportService(trRepo, mfgService, { isDateLocked: async () => false }, { log: async () => {} });

const TABLES = sql`TRUNCATE attendance_sessions, production_groups, stamp_sessions, time_reports, employees, mo_reports, mo_material_consumptions, mo_operations, manufacturing_orders, routing_operations, work_centers, bom_components, articles, payroll_periods, audit_log, users CASCADE`;
beforeEach(async () => {
  await db.execute(TABLES);
});
afterAll(async () => {
  await db.execute(TABLES);
});

async function setup() {
  const user = await authRepo.create({
    email: `sac-${crypto.randomUUID()}@example.com`,
    passwordHash: "x",
    name: "Ledare",
    role: "admin",
  });
  const article = await articleService.createArticle({
    articleNumber: `SAC-${crypto.randomUUID()}`,
    name: "Stol",
    type: "manufactured",
    unit: "st",
    active: true,
  });
  const wc = await mfgService.createWorkCenter({ code: "100", name: "Svets", hourlyRate: 500, overheadPercent: 20, active: true });
  await mfgService.createRoutingOperation(article.id, { sequenceNo: 1, workCenterId: wc.id, setupTime: 10, runTimePerUnit: 2 });
  const order = await mfgService.createManufacturingOrder({ articleId: article.id, quantity: 5 }, user.id);
  const [operation] = await mfgService.listOperations(order.id);
  const employee = await trRepo.createEmployee({ employeeNumber: `E-${crypto.randomUUID().slice(0, 6)}`, name: "Kalle", active: true });
  return { user, order, operation: operation!, employee };
}

async function setStamp(id: string, startedAt: Date, pausedAt: Date | null) {
  await db.update(stampSessions).set({ startedAt, pausedAt }).where(eq(stampSessions.id, id));
}

async function openStamps(orderId: string) {
  return [
    ...(await db.execute(
      sql`SELECT s.id FROM stamp_sessions s JOIN mo_operations o ON o.id = s.mo_operation_id WHERE o.manufacturing_order_id = ${orderId} AND s.stopped_at IS NULL`
    )),
  ] as { id: string }[];
}

async function timeReportCount(employeeId: string) {
  const [row] = [
    ...(await db.execute(sql`SELECT count(*)::int AS n FROM time_reports WHERE employee_id = ${employeeId}`)),
  ] as { n: number }[];
  return row!.n;
}

// listReports does not carry employee_id/marked_done, so the log's own
// columns are read directly.
async function reportRows(orderId: string) {
  return [
    ...(await db.execute(
      sql`SELECT id, source, employee_id, marked_done, quantity_ok, quantity_scrapped, time_report_id FROM mo_reports WHERE manufacturing_order_id = ${orderId} ORDER BY created_at`
    )),
  ] as {
    id: string;
    source: string;
    employee_id: string | null;
    marked_done: boolean;
    quantity_ok: string;
    quantity_scrapped: string;
    time_report_id: string | null;
  }[];
}

describe("regel 10: a done operation stamps out everyone else", () => {
  it("terminal stamp-out with Operationen är klar closes the colleague's paused stamp, not twice the own", async () => {
    const { user, order, operation, employee } = await setup();
    const colleague = await trRepo.createEmployee({ employeeNumber: "E-COL", name: "Anna", active: true });
    const own = await trService.stampIn({ employeeId: employee.id, moOperationId: operation.id }, user.id);
    const theirs = await trService.stampIn({ employeeId: colleague.id, moOperationId: operation.id }, user.id);
    const pausedAt = new Date(Date.now() - 20 * HOUR);
    await setStamp(theirs.id, new Date(pausedAt.getTime() - 2 * HOUR), pausedAt);

    await trService.stampOut(
      own.id,
      stampOutSchema.parse({ quantityOk: 5, quantityScrapped: 0, markOperationDone: true }),
      user.id
    );

    expect(await openStamps(order.id)).toHaveLength(0);
    const auto = (await reportRows(order.id)).filter((r) => r.source === "auto_close");
    expect(auto).toHaveLength(1);
    expect(auto[0]!.employee_id).toBe(colleague.id);
    expect(Number(auto[0]!.quantity_ok)).toBe(0);
    expect(Number(auto[0]!.quantity_scrapped)).toBe(0);
    expect(auto[0]!.marked_done).toBe(false);
    // The colleague's time stops at the pause start.
    const [closed] = await db.select().from(stampSessions).where(eq(stampSessions.id, theirs.id));
    expect(closed!.stoppedAt!.getTime()).toBe(pausedAt.getTime());
    expect(closed!.timeReportId).toBe(auto[0]!.time_report_id);
    // Shown on the TO card as the colleague's row.
    const listed = (await mfgService.listReports(order.id)).filter((r) => r.source === "auto_close");
    expect(listed.map((r) => r.employeeName)).toEqual(["Anna"]);
    expect(await timeReportCount(employee.id)).toBe(1);
  });

  it("Slutför operation on the card closes open stamps on that operation only", async () => {
    const { user, employee } = await setup();
    // Own two-operation order: the first operation is not the last, so
    // finishing it completes no order and must leave operation 2's stamp open.
    const article = await articleService.createArticle({
      articleNumber: `SAC2-${crypto.randomUUID()}`,
      name: "Bord",
      type: "manufactured",
      unit: "st",
      active: true,
    });
    const wc = await mfgService.createWorkCenter({ code: "200", name: "Måla", hourlyRate: 400, overheadPercent: 10, active: true });
    await mfgService.createRoutingOperation(article.id, { sequenceNo: 1, workCenterId: wc.id, setupTime: 5, runTimePerUnit: 1 });
    await mfgService.createRoutingOperation(article.id, { sequenceNo: 2, workCenterId: wc.id, setupTime: 5, runTimePerUnit: 1 });
    const order = await mfgService.createManufacturingOrder({ articleId: article.id, quantity: 3 }, user.id);
    const [first, second] = (await mfgService.listOperations(order.id)).sort((a, b) => a.sequenceNo - b.sequenceNo);
    const colleague = await trRepo.createEmployee({ employeeNumber: "E-OP2", name: "Eva", active: true });
    await trService.stampIn({ employeeId: employee.id, moOperationId: first!.id }, user.id);
    const onSecond = await trService.stampIn({ employeeId: colleague.id, moOperationId: second!.id }, user.id);

    await mfgService.completeOperation(first!.id, completeOperationSchema.parse({}), user.id);

    const open = await openStamps(order.id);
    expect(open).toHaveLength(1);
    expect(open[0]!.id).toBe(onSecond.id);
    const auto = (await reportRows(order.id)).filter((r) => r.source === "auto_close");
    expect(auto.map((r) => r.employee_id)).toEqual([employee.id]);
  });

  it("Slutför order closes every stamp on the order", async () => {
    const { user, order, operation, employee } = await setup();
    await trService.stampIn({ employeeId: employee.id, moOperationId: operation.id }, user.id);

    await mfgService.complete(order.id, { quantity: 0 }, user.id);

    expect(await openStamps(order.id)).toHaveLength(0);
    const reports = await mfgService.listReports(order.id);
    expect(reports.some((r) => r.source === "auto_close")).toBe(true);
  });

  it("a report that does not finish the operation leaves other stamps open", async () => {
    const { user, order, operation, employee } = await setup();
    const colleague = await trRepo.createEmployee({ employeeNumber: "E-COL2", name: "Bo", active: true });
    const own = await trService.stampIn({ employeeId: employee.id, moOperationId: operation.id }, user.id);
    await trService.stampIn({ employeeId: colleague.id, moOperationId: operation.id }, user.id);

    await trService.stampOut(own.id, stampOutSchema.parse({ quantityOk: 1, quantityScrapped: 0 }), user.id);

    expect(await openStamps(order.id)).toHaveLength(1);
    expect((await reportRows(order.id)).some((r) => r.source === "auto_close")).toBe(false);
  });

  it("undoing the report that finished the operation leaves the auto-closed stamps closed (Review Focus 5)", async () => {
    const { user, order, operation, employee } = await setup();
    const colleague = await trRepo.createEmployee({ employeeNumber: "E-COL3", name: "Cia", active: true });
    const own = await trService.stampIn({ employeeId: employee.id, moOperationId: operation.id }, user.id);
    await trService.stampIn({ employeeId: colleague.id, moOperationId: operation.id }, user.id);
    await trService.stampOut(
      own.id,
      stampOutSchema.parse({ quantityOk: 2, quantityScrapped: 0, markOperationDone: true }),
      user.id
    );

    const reports = await reportRows(order.id);
    const finishing = reports.find((r) => r.source === "terminal" && r.marked_done)!;
    expect(finishing).toBeDefined();
    await mfgService.undoReport(order.id, finishing.id, user.id);

    expect(await openStamps(order.id)).toHaveLength(0);
    expect(await timeReportCount(colleague.id)).toBe(1);
    const auto = reports.find((r) => r.source === "auto_close")!;
    await mfgService.undoReport(order.id, auto.id, user.id); // the auto-close row is undoable on its own
    expect(await timeReportCount(colleague.id)).toBe(0);
  });

  it("the material dry run closes nothing", async () => {
    const { user, order, operation, employee } = await setup();
    const colleague = await trRepo.createEmployee({ employeeNumber: "E-COL4", name: "Dan", active: true });
    await trService.stampIn({ employeeId: colleague.id, moOperationId: operation.id }, user.id);

    // A report that would mark the (last) operation done and complete the
    // order — rolled back, so the colleague stays stamped in.
    await mfgRepo.dryRunOperationReport(operation.id, {
      quantityOk: 5,
      quantityScrapped: 0,
      markDone: true,
      employeeId: employee.id,
      createdBy: user.id,
      source: "terminal",
    });

    expect(await openStamps(order.id)).toHaveLength(1);
    expect(await reportRows(order.id)).toHaveLength(0);
  });
});

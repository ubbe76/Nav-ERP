import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { eq, sql } from "drizzle-orm";
import { db, stampSessions, timeReports } from "@navet/db";
import { testArticleService, testDocumentPdfService } from "./helpers/services.js";
import { createArticleRepository } from "../src/modules/article/repository/article.repository.js";
import { createArticleService } from "../src/modules/article/service/article.service.js";
import { createAuthRepository } from "../src/modules/auth/repository/auth.repository.js";
import { createManufacturingRepository } from "../src/modules/manufacturing/repository/manufacturing.repository.js";
import { createManufacturingService } from "../src/modules/manufacturing/service/manufacturing.service.js";
import { createTimeReportRepository } from "../src/modules/timereport/repository/timereport.repository.js";
import {
  closeStampSessionsInTx,
  effectiveStopTime,
  localDateOf,
  stampedHours,
} from "../src/modules/timereport/repository/stamp-close.js";

const HOUR = 3_600_000;
const t0 = new Date("2026-10-14T06:00:00Z");

describe("stampedHours", () => {
  it("counts start to stop without pauses", () => {
    expect(stampedHours({ startedAt: t0, pausedAt: null, pausedSeconds: "0" }, new Date(t0.getTime() + 2.5 * HOUR))).toBe(2.5);
  });
  it("subtracts finished pauses", () => {
    expect(stampedHours({ startedAt: t0, pausedAt: null, pausedSeconds: "3600" }, new Date(t0.getTime() + 3 * HOUR))).toBe(2);
  });
  it("subtracts an ongoing pause up to the stop time", () => {
    const pausedAt = new Date(t0.getTime() + 2 * HOUR);
    expect(stampedHours({ startedAt: t0, pausedAt, pausedSeconds: "0" }, new Date(t0.getTime() + 20 * HOUR))).toBe(2);
  });
  it("ignores an ongoing pause that starts after the stop time", () => {
    const pausedAt = new Date(t0.getTime() + 5 * HOUR);
    expect(stampedHours({ startedAt: t0, pausedAt, pausedSeconds: "0" }, new Date(t0.getTime() + 1 * HOUR))).toBe(1);
  });
  it("floors at 0.01 hours", () => {
    expect(stampedHours({ startedAt: t0, pausedAt: null, pausedSeconds: "0" }, t0)).toBe(0.01);
  });
});

describe("effectiveStopTime", () => {
  it("is the pause start for a paused stamp, otherwise `at`", () => {
    const at = new Date(t0.getTime() + 24 * HOUR);
    const pausedAt = new Date(t0.getTime() + 9 * HOUR);
    expect(effectiveStopTime({ pausedAt }, at)).toEqual(pausedAt);
    expect(effectiveStopTime({ pausedAt: null }, at)).toEqual(at);
  });
});

const articleService = createArticleService(createArticleRepository(db));
const mfgService = createManufacturingService(createManufacturingRepository(db), testDocumentPdfService, testArticleService);
const authRepo = createAuthRepository(db);
const trRepo = createTimeReportRepository(db);

const TABLES = sql`TRUNCATE attendance_sessions, production_groups, stamp_sessions, time_reports, employees, mo_reports, mo_material_consumptions, mo_operations, manufacturing_orders, routing_operations, work_centers, bom_components, articles, payroll_periods, audit_log, users CASCADE`;
beforeEach(async () => {
  await db.execute(TABLES);
});
afterAll(async () => {
  await db.execute(TABLES);
});

async function setup() {
  const user = await authRepo.create({
    email: `sc-${crypto.randomUUID()}@example.com`,
    passwordHash: "x",
    name: "Ledare",
    role: "admin",
  });
  const article = await articleService.createArticle({
    articleNumber: `SC-${crypto.randomUUID()}`,
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

describe("closeStampSessionsInTx", () => {
  it("stops a paused stamp at the pause start and an open one at `at`", async () => {
    const { user, operation, employee } = await setup();
    const other = await trRepo.createEmployee({ employeeNumber: "E-OTHER", name: "Anna", active: true });
    const paused = await trRepo.createStampSession(employee.id, operation.id, user.id);
    const open = await trRepo.createStampSession(other.id, operation.id, user.id);
    const at = new Date();
    await setStamp(paused.id, new Date(at.getTime() - 26 * HOUR), new Date(at.getTime() - 24 * HOUR));
    await setStamp(open.id, new Date(at.getTime() - 3 * HOUR), null);

    const closed = await db.transaction((tx) =>
      closeStampSessionsInTx(tx, { operationIds: [operation.id], at, createdBy: user.id, note: "Automatisk utstämpling: operationen klar" })
    );

    expect(closed).toHaveLength(2);
    const [p] = await db.select().from(stampSessions).where(eq(stampSessions.id, paused.id));
    const [o] = await db.select().from(stampSessions).where(eq(stampSessions.id, open.id));
    expect(p!.stoppedAt!.getTime()).toBe(at.getTime() - 24 * HOUR);
    expect(o!.stoppedAt!.getTime()).toBe(at.getTime());
    const [pr] = await db.select().from(timeReports).where(eq(timeReports.id, p!.timeReportId!));
    const [or] = await db.select().from(timeReports).where(eq(timeReports.id, o!.timeReportId!));
    expect(pr!.hours).toBe("2.00");
    expect(pr!.date).toBe(localDateOf(new Date(at.getTime() - 24 * HOUR)));
    expect(pr!.note).toBe("Automatisk utstämpling: operationen klar");
    expect(or!.hours).toBe("3.00");
  });

  it("dates the time report today when the stop day is in a locked payroll period", async () => {
    const { user, operation, employee } = await setup();
    const stamp = await trRepo.createStampSession(employee.id, operation.id, user.id);
    const pausedAt = new Date("2026-08-20T14:00:00Z");
    await setStamp(stamp.id, new Date("2026-08-20T06:00:00Z"), pausedAt);
    await db.execute(sql`INSERT INTO payroll_periods (year, month, status) VALUES (2026, 8, 'locked')`);
    const at = new Date();

    const [closed] = await db.transaction((tx) =>
      closeStampSessionsInTx(tx, { operationIds: [operation.id], at, createdBy: user.id, note: "x" })
    );

    const [report] = await db.select().from(timeReports).where(eq(timeReports.id, closed!.timeReportId));
    expect(report!.date).toBe(localDateOf(at));
    expect(report!.hours).toBe("8.00");
  });

  it("closes every operation's stamps when given the order", async () => {
    const { user, order, operation, employee } = await setup();
    await trRepo.createStampSession(employee.id, operation.id, user.id);
    const closed = await db.transaction((tx) =>
      closeStampSessionsInTx(tx, { orderId: order.id, at: new Date(), createdBy: user.id, note: "x" })
    );
    expect(closed.map((c) => c.employeeId)).toEqual([employee.id]);
  });

  it("leaves already stopped stamps alone and returns [] for an empty operation list", async () => {
    const { user, operation, employee } = await setup();
    const stamp = await trRepo.createStampSession(employee.id, operation.id, user.id);
    await db.update(stampSessions).set({ stoppedAt: new Date() }).where(eq(stampSessions.id, stamp.id));
    const none = await db.transaction((tx) =>
      closeStampSessionsInTx(tx, { operationIds: [operation.id], at: new Date(), createdBy: user.id, note: "x" })
    );
    expect(none).toEqual([]);
    const empty = await db.transaction((tx) =>
      closeStampSessionsInTx(tx, { operationIds: [], at: new Date(), createdBy: user.id, note: "x" })
    );
    expect(empty).toEqual([]);
  });
});

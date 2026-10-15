import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import { db, permissionGroups } from "@navet/db";
import { buildApp } from "../src/app.js";
import { createAuthService } from "../src/modules/auth/service/auth.service.js";
import { testArticleService, testDocumentPdfService } from "./helpers/services.js";
import { createArticleRepository } from "../src/modules/article/repository/article.repository.js";
import { createArticleService } from "../src/modules/article/service/article.service.js";
import { createAuthRepository } from "../src/modules/auth/repository/auth.repository.js";
import { createManufacturingRepository } from "../src/modules/manufacturing/repository/manufacturing.repository.js";
import { createManufacturingService } from "../src/modules/manufacturing/service/manufacturing.service.js";
import { createTimeReportRepository } from "../src/modules/timereport/repository/timereport.repository.js";
import { createTimeReportService } from "../src/modules/timereport/service/timereport.service.js";
import { createAuditRepository } from "../src/modules/system/repository/audit.repository.js";

// Regel 6 at the route: a stop time (Sluttid) on Stämpla ut is a
// supervisor's correction on Pågående arbete — the shop floor's terminal
// profile is refused it, even though it may stamp out.

const articleService = createArticleService(createArticleRepository(db));
const authRepo = createAuthRepository(db);
const mfgService = createManufacturingService(createManufacturingRepository(db), testDocumentPdfService, testArticleService);
const timeReportService = createTimeReportService(
  createTimeReportRepository(db),
  mfgService,
  { isDateLocked: async () => false },
  { log: async () => {} }
);

const TRUNCATE = sql`TRUNCATE mo_reports, mo_report_materials, attendance_sessions, stamp_sessions, time_reports, employees, mo_material_consumptions, mo_operations, manufacturing_orders, routing_operations, work_centers, production_groups, bom_components, articles, payroll_periods, audit_log, user_settings, users CASCADE`;
// Only the groups this file creates — the migration's seeded groups (ALLA,
// VERKSTAD) belong to other test files.
const DELETE_GROUPS = sql`DELETE FROM permission_groups WHERE code LIKE 'STOP%'`;

beforeEach(async () => {
  await db.execute(TRUNCATE);
  await db.execute(DELETE_GROUPS);
});

afterAll(async () => {
  await db.execute(TRUNCATE);
  await db.execute(DELETE_GROUPS);
});

// A released TO with one operation, an employee, and that employee stamped
// in on it two hours ago.
async function setup() {
  const user = await authRepo.create({
    email: `stop-${crypto.randomUUID()}@example.com`,
    passwordHash: "x",
    name: "Arbetsledare",
    role: "supervisor",
  });
  const parent = await articleService.createArticle({
    articleNumber: `P-${crypto.randomUUID()}`,
    name: "Produkt",
    type: "manufactured",
    unit: "st",
    active: true,
  });
  const workCenter = await mfgService.createWorkCenter({ code: "100", name: "Svets", active: true });
  await mfgService.createRoutingOperation(parent.id, { sequenceNo: 10, workCenterId: workCenter.id, setupTime: 10, runTimePerUnit: 2 });
  const order = await mfgService.createManufacturingOrder({ articleId: parent.id, quantity: 5 }, user.id);
  const [operation] = await mfgService.listOperations(order.id);
  const employee = await timeReportService.createEmployee({ employeeNumber: "107", name: "Urban", active: true });
  const stamp = await timeReportService.stampIn({ employeeId: employee.id, moOperationId: operation!.id }, user.id);
  const startedAt = new Date(Date.now() - 2 * 3_600_000);
  await db.execute(sql`UPDATE stamp_sessions SET started_at = ${startedAt.toISOString()}::timestamptz WHERE id = ${stamp.id}`);
  return { stamp, startedAt };
}

describe("POST /stamp-sessions/:id/stop with a stop time", () => {
  const app = buildApp();
  const authService = createAuthService(createAuthRepository(db), "unused", createAuditRepository(db));

  afterAll(async () => {
    await app.close();
  });

  async function session(role: "user" | "supervisor", permissions: string[]) {
    const [group] = await db
      .insert(permissionGroups)
      .values({ code: `STOP${crypto.randomUUID().slice(0, 8)}`, name: "Stämpling", permissions })
      .returning();
    const email = `r-${crypto.randomUUID()}@example.com`;
    await authService.createUser({ email, password: "correcthorse", name: "R", role, permissionGroupId: group!.id });
    const res = await app.inject({ method: "POST", url: "/api/v1/auth/login", payload: { email, password: "correcthorse" } });
    return `session=${res.cookies.find((c) => c.name === "session")!.value}`;
  }

  it("refuses the shop floor, rejects a stop before the start and accepts a valid one for a supervisor", async () => {
    const { stamp, startedAt } = await setup();
    const url = `/api/v1/stamp-sessions/${stamp.id}/stop`;

    // The terminal profile: role user, no menus, only the terminal.
    const shopFloor = await session("user", ["terminal"]);
    const refused = await app.inject({
      method: "POST",
      url,
      headers: { cookie: shopFloor },
      payload: { stoppedAt: new Date(startedAt.getTime() + 3_600_000).toISOString() },
    });
    expect([refused.statusCode, refused.json().code]).toEqual([403, "stop-time-not-allowed"]);

    const supervisor = await session("supervisor", ["tillverkning"]);
    const early = await app.inject({
      method: "POST",
      url,
      headers: { cookie: supervisor },
      payload: { stoppedAt: new Date(startedAt.getTime() - 60_000).toISOString() },
    });
    expect([early.statusCode, early.json().code]).toEqual([400, "invalid-stop-time"]);

    const stoppedAt = new Date(startedAt.getTime() + 90 * 60_000);
    const ok = await app.inject({
      method: "POST",
      url,
      headers: { cookie: supervisor },
      payload: { stoppedAt: stoppedAt.toISOString() },
    });
    expect(ok.statusCode).toBe(200);
    expect(ok.json().timeReport.hours).toBe("1.50");
    expect(new Date(ok.json().session.stoppedAt).getTime()).toBe(stoppedAt.getTime());
  });
});

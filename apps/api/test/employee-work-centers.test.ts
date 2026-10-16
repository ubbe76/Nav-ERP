import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import { db } from "@navet/db";
import { buildApp } from "../src/app.js";
import { createAuthService } from "../src/modules/auth/service/auth.service.js";
import { createAuthRepository } from "../src/modules/auth/repository/auth.repository.js";
import { createAuditRepository } from "../src/modules/system/repository/audit.repository.js";
import { testArticleService, testDocumentPdfService } from "./helpers/services.js";
import { createManufacturingRepository } from "../src/modules/manufacturing/repository/manufacturing.repository.js";
import {
  WorkCenterNotFoundError,
  createManufacturingService,
} from "../src/modules/manufacturing/service/manufacturing.service.js";
import { createTimeReportRepository } from "../src/modules/timereport/repository/timereport.repository.js";
import { createTimeReportService } from "../src/modules/timereport/service/timereport.service.js";

// Förvalda stationer: the work centers an employee usually works at, stored
// in employee_work_centers and replaced as a whole set by PATCH /employees/:id.

const mfgService = createManufacturingService(createManufacturingRepository(db), testDocumentPdfService, testArticleService);
const service = createTimeReportService(
  createTimeReportRepository(db),
  mfgService,
  { isDateLocked: async () => false },
  { log: async () => {} }
);

const TRUNCATE = sql`TRUNCATE employee_work_centers, employees, work_centers, production_groups, audit_log, user_settings, users CASCADE`;

beforeEach(async () => {
  await db.execute(TRUNCATE);
});

afterAll(async () => {
  await db.execute(TRUNCATE);
});

async function setup() {
  const employee = await service.createEmployee({ employeeNumber: "107", name: "Urban", active: true });
  const svets = await mfgService.createWorkCenter({ code: "100", name: "Svets", active: true });
  const kant = await mfgService.createWorkCenter({ code: "200", name: "Kantvik", active: true });
  return { employee, svets, kant };
}

const sorted = (ids: string[]) => [...ids].sort();

describe("employee default work centers (Förvalda stationer)", () => {
  it("replaces the set on PATCH and returns it on getEmployee", async () => {
    const { employee, svets, kant } = await setup();

    const updated = await service.updateEmployee(employee.id, { defaultWorkCenterIds: [svets.id, kant.id] });
    expect(sorted(updated.defaultWorkCenterIds)).toEqual(sorted([svets.id, kant.id]));
    expect(sorted((await service.getEmployee(employee.id))!.defaultWorkCenterIds)).toEqual(sorted([svets.id, kant.id]));

    await service.updateEmployee(employee.id, { defaultWorkCenterIds: [kant.id] });
    expect((await service.getEmployee(employee.id))!.defaultWorkCenterIds).toEqual([kant.id]);

    await service.updateEmployee(employee.id, { defaultWorkCenterIds: [] });
    expect((await service.getEmployee(employee.id))!.defaultWorkCenterIds).toEqual([]);
  });

  it("leaves the set alone when the field is omitted, and updates other fields with it", async () => {
    const { employee, svets } = await setup();
    await service.updateEmployee(employee.id, { defaultWorkCenterIds: [svets.id] });

    const renamed = await service.updateEmployee(employee.id, { name: "Urban K" });
    expect(renamed.name).toBe("Urban K");
    expect(renamed.defaultWorkCenterIds).toEqual([svets.id]);

    const both = await service.updateEmployee(employee.id, { name: "Urban", defaultWorkCenterIds: [] });
    expect(both.name).toBe("Urban");
    expect(both.defaultWorkCenterIds).toEqual([]);
  });

  it("tolerates a duplicated id in the set", async () => {
    const { employee, svets } = await setup();
    const updated = await service.updateEmployee(employee.id, { defaultWorkCenterIds: [svets.id, svets.id] });
    expect(updated.defaultWorkCenterIds).toEqual([svets.id]);
  });

  it("refuses an unknown work center and changes nothing", async () => {
    const { employee, svets } = await setup();
    await service.updateEmployee(employee.id, { defaultWorkCenterIds: [svets.id] });

    const unknown = crypto.randomUUID();
    await expect(
      service.updateEmployee(employee.id, { name: "Annat namn", defaultWorkCenterIds: [unknown] })
    ).rejects.toBeInstanceOf(WorkCenterNotFoundError);

    const after = (await service.getEmployee(employee.id))!;
    expect(after.name).toBe("Urban");
    expect(after.defaultWorkCenterIds).toEqual([svets.id]);
  });

  it("carries defaultWorkCenterIds in the directory, [] when none chosen", async () => {
    const { employee, svets } = await setup();
    const other = await service.createEmployee({ employeeNumber: "108", name: "Kalle", active: true });
    await service.updateEmployee(employee.id, { defaultWorkCenterIds: [svets.id] });

    const directory = await service.listEmployeeDirectory();
    expect(directory.find((e) => e.id === employee.id)!.defaultWorkCenterIds).toEqual([svets.id]);
    expect(directory.find((e) => e.id === other.id)!.defaultWorkCenterIds).toEqual([]);
    // The directory stays free of personal data.
    expect(Object.keys(directory[0]!).sort()).toEqual(["active", "defaultWorkCenterIds", "employeeNumber", "id", "name"]);
  });

  it("drops a deleted work center from the defaults (FK cascade)", async () => {
    const { employee, svets, kant } = await setup();
    await service.updateEmployee(employee.id, { defaultWorkCenterIds: [svets.id, kant.id] });

    await db.execute(sql`DELETE FROM work_centers WHERE id = ${svets.id}`);
    expect((await service.getEmployee(employee.id))!.defaultWorkCenterIds).toEqual([kant.id]);
  });
});

describe("PATCH /employees/:id with defaultWorkCenterIds", () => {
  const app = buildApp();
  const authService = createAuthService(createAuthRepository(db), "unused", createAuditRepository(db));

  afterAll(async () => {
    await app.close();
  });

  async function adminCookie() {
    const email = `ewc-${crypto.randomUUID()}@example.com`;
    await authService.createUser({ email, password: "correcthorse", name: "Admin", role: "admin" });
    const res = await app.inject({ method: "POST", url: "/api/v1/auth/login", payload: { email, password: "correcthorse" } });
    return `session=${res.cookies.find((c) => c.name === "session")!.value}`;
  }

  it("answers 400 work-center-not-found for an unknown work center in the body", async () => {
    const { employee } = await setup();
    const cookie = await adminCookie();
    const res = await app.inject({
      method: "PATCH",
      url: `/api/v1/employees/${employee.id}`,
      headers: { cookie },
      payload: { defaultWorkCenterIds: [crypto.randomUUID()] },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().code).toBe("work-center-not-found");
  });

  it("stores the set and serves it on GET /employees/:id and /employees/directory", async () => {
    const { employee, svets } = await setup();
    const cookie = await adminCookie();
    const patch = await app.inject({
      method: "PATCH",
      url: `/api/v1/employees/${employee.id}`,
      headers: { cookie },
      payload: { defaultWorkCenterIds: [svets.id] },
    });
    expect(patch.statusCode).toBe(200);
    expect(patch.json().defaultWorkCenterIds).toEqual([svets.id]);

    const get = await app.inject({ method: "GET", url: `/api/v1/employees/${employee.id}`, headers: { cookie } });
    expect(get.json().defaultWorkCenterIds).toEqual([svets.id]);

    const dir = await app.inject({ method: "GET", url: "/api/v1/employees/directory", headers: { cookie } });
    expect(dir.json().find((e: { id: string }) => e.id === employee.id).defaultWorkCenterIds).toEqual([svets.id]);
  });

  it("still answers 404 for an unknown employee", async () => {
    await setup();
    const cookie = await adminCookie();
    const res = await app.inject({
      method: "PATCH",
      url: `/api/v1/employees/${crypto.randomUUID()}`,
      headers: { cookie },
      payload: { defaultWorkCenterIds: [] },
    });
    expect(res.statusCode).toBe(404);
  });
});

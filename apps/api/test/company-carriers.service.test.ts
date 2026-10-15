import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { and, eq, sql } from "drizzle-orm";
import { auditLog, db } from "@navet/db";
import { createSystemRepository } from "../src/modules/system/repository/system.repository.js";
import {
  CarrierNotFoundError,
  CompanyCarrierNotFoundError,
  createSystemService,
  DuplicateCompanyCarrierError,
} from "../src/modules/system/service/system.service.js";
import { createRegisterRepository } from "../src/modules/register/repository/register.repository.js";
import { createRegisterService } from "../src/modules/register/service/register.service.js";
import { createAuthRepository } from "../src/modules/auth/repository/auth.repository.js";
import { createAuditRepository } from "../src/modules/system/repository/audit.repository.js";

const auditRepository = createAuditRepository(db);
const systemService = createSystemService(createSystemRepository(db), auditRepository);
const registerService = createRegisterService(createRegisterRepository(db));
const authRepo = createAuthRepository(db);

// carriers CASCADE also clears company_carriers (FK) and any partner/order rows.
const TRUNCATE = sql`TRUNCATE company_carriers, carriers, audit_log, users CASCADE`;

beforeEach(async () => {
  await db.execute(TRUNCATE);
});

afterAll(async () => {
  await db.execute(TRUNCATE);
});

async function makeCarrier(code = "DHL", name = "DHL Freight") {
  return registerService.carriers.create({ code, name });
}

async function makeUser() {
  return authRepo.create({
    email: `speditor-${crypto.randomUUID()}@example.com`,
    passwordHash: "not-a-real-hash",
    name: "Admin",
    role: "admin",
  });
}

async function auditRows(entityType: string, action: string) {
  return db
    .select()
    .from(auditLog)
    .where(and(eq(auditLog.entityType, entityType), eq(auditLog.action, action)));
}

describe("company carriers (Företagsinformation → Speditörer)", () => {
  it("adds a carrier account and lists it with the carrier name", async () => {
    const carrier = await makeCarrier();
    const created = await systemService.addCompanyCarrier({ carrierId: carrier.id, customerNumber: "12345" });
    expect(created.customerNumber).toBe("12345");

    const list = await systemService.listCompanyCarriers();
    expect(list).toHaveLength(1);
    expect(list[0]!.carrierName).toBe("DHL Freight");
    expect(list[0]!.carrierCode).toBe("DHL");
    expect(list[0]!.customerNumber).toBe("12345");
  });

  it("rejects a duplicate carrier and an unknown carrier", async () => {
    const carrier = await makeCarrier();
    await systemService.addCompanyCarrier({ carrierId: carrier.id, customerNumber: "1" });
    await expect(
      systemService.addCompanyCarrier({ carrierId: carrier.id, customerNumber: "2" })
    ).rejects.toThrow(DuplicateCompanyCarrierError);
    await expect(
      systemService.addCompanyCarrier({ carrierId: crypto.randomUUID(), customerNumber: "3" })
    ).rejects.toThrow(CarrierNotFoundError);
  });

  it("updates the customer number and resolves getCompanyCarrierNumber", async () => {
    const carrier = await makeCarrier();
    const created = await systemService.addCompanyCarrier({ carrierId: carrier.id, customerNumber: "old" });
    await systemService.updateCompanyCarrier(created.id, { customerNumber: "new" });
    expect(await systemService.getCompanyCarrierNumber(carrier.id)).toBe("new");
    expect(await systemService.getCompanyCarrierNumber(crypto.randomUUID())).toBeNull();
  });

  it("removes a carrier account and 404s on unknown id", async () => {
    const carrier = await makeCarrier();
    const created = await systemService.addCompanyCarrier({ carrierId: carrier.id, customerNumber: "1" });
    await systemService.removeCompanyCarrier(created.id);
    expect(await systemService.listCompanyCarriers()).toHaveLength(0);
    await expect(systemService.removeCompanyCarrier(crypto.randomUUID())).rejects.toThrow(CompanyCarrierNotFoundError);
    await expect(
      systemService.updateCompanyCarrier(crypto.randomUUID(), { customerNumber: "x" })
    ).rejects.toThrow(CompanyCarrierNotFoundError);
  });
});

// G1: audit trail — entityId is the carrier's own CODE (readable, e.g.
// "DHL"), not the company_carriers row's uuid.
describe("company carriers — audit log", () => {
  it("logs created/updated/deleted with the acting user, entityId = carrier code", async () => {
    const carrier = await makeCarrier("DHL", "DHL Freight");
    const user = await makeUser();

    const created = await systemService.addCompanyCarrier({ carrierId: carrier.id, customerNumber: "12345" }, user.id);
    const createdRows = await auditRows("company_carrier", "created");
    expect(createdRows).toHaveLength(1);
    expect(createdRows[0]!.entityId).toBe("DHL");
    expect(createdRows[0]!.userId).toBe(user.id);
    expect(createdRows[0]!.detail).toEqual({ customerNumber: "12345" });

    await systemService.updateCompanyCarrier(created.id, { customerNumber: "67890" }, user.id);
    const updatedRows = await auditRows("company_carrier", "updated");
    expect(updatedRows).toHaveLength(1);
    expect(updatedRows[0]!.entityId).toBe("DHL");
    expect(updatedRows[0]!.detail).toEqual({
      before: { customerNumber: "12345" },
      after: { customerNumber: "67890" },
    });

    await systemService.removeCompanyCarrier(created.id, user.id);
    const deletedRows = await auditRows("company_carrier", "deleted");
    expect(deletedRows).toHaveLength(1);
    expect(deletedRows[0]!.entityId).toBe("DHL");
    expect(deletedRows[0]!.userId).toBe(user.id);
  });
});

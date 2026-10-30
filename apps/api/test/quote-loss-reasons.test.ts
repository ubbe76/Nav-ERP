import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { eq, sql } from "drizzle-orm";
import { customers, db, permissionGroups, quoteLossReasons, salesOrders } from "@navet/db";
import { quoteLossReasonInputSchema } from "@navet/shared";
import { buildApp } from "../src/app.js";
import { createAuthRepository } from "../src/modules/auth/repository/auth.repository.js";
import { createAuthService } from "../src/modules/auth/service/auth.service.js";
import { createAuditRepository } from "../src/modules/system/repository/audit.repository.js";
import { createRegisterRepository } from "../src/modules/register/repository/register.repository.js";
import {
  createRegisterService,
  DuplicateRegisterEntryError,
  InvalidReplacementError,
  RegisterEntryInUseError,
  RegisterEntryNotFoundError,
} from "../src/modules/register/service/register.service.js";

// Förlustorsaker — the register behind Förlorad: the service (duplicates,
// usage, delete with reassignment) and the routes (Försäljning writes,
// other office menus read, the delete is admin like every register).

const service = createRegisterService(createRegisterRepository(db));
const authService = createAuthService(createAuthRepository(db), "unused", createAuditRepository(db));
const PASSWORD = "correcthorsebattery";

// payment_terms too: a test below creates the term "30", which another file
// in the same worker may have left behind.
const TRUNCATE = sql`TRUNCATE sales_order_rows, sales_orders, customers, quote_loss_reasons, payment_terms, user_settings, users, audit_log CASCADE`;
const DELETE_GROUPS = sql`DELETE FROM permission_groups WHERE code LIKE 'QLR%'`;

let app: ReturnType<typeof buildApp>;

beforeAll(async () => {
  app = buildApp();
  await app.ready();
});
beforeEach(async () => {
  await db.execute(TRUNCATE);
  await db.execute(DELETE_GROUPS);
});
afterAll(async () => {
  await app.close();
  await db.execute(TRUNCATE);
  await db.execute(DELETE_GROUPS);
});

async function lostQuote(reasonId: string) {
  const [customer] = await db.insert(customers).values({ customerNumber: `K${crypto.randomUUID().slice(0, 6)}`, name: "Kund AB" }).returning();
  const [order] = await db
    .insert(salesOrders)
    .values({ orderNumber: `KO-${crypto.randomUUID().slice(0, 6)}`, customerId: customer!.id, status: "lost", quoted: true, lostReasonId: reasonId })
    .returning();
  return order!;
}

describe("quoteLossReasonInputSchema", () => {
  it("upper-cases the code and refuses anything but letters/digits up to 10", () => {
    expect(quoteLossReasonInputSchema.parse({ code: " pris ", name: "Pris" })).toEqual({ code: "PRIS", name: "Pris", active: true });
    expect(quoteLossReasonInputSchema.safeParse({ code: "PR IS", name: "Pris" }).success).toBe(false);
    expect(quoteLossReasonInputSchema.safeParse({ code: "ABCDEFGHIJK", name: "Pris" }).success).toBe(false);
    expect(quoteLossReasonInputSchema.safeParse({ code: "", name: "Pris" }).success).toBe(false);
    expect(quoteLossReasonInputSchema.safeParse({ code: "ÅÄÖ", name: "Pris" }).success).toBe(false);
  });
});

describe("förlustorsaker — service", () => {
  it("creates, lists in code order, updates and toggles active", async () => {
    const pris = await service.quoteLossReasons.create({ code: "PRIS", name: "Pris", active: true });
    await service.quoteLossReasons.create({ code: "ANNAN", name: "Valde annan leverantör", active: true });
    expect((await service.quoteLossReasons.list()).map((r) => r.code)).toEqual(["ANNAN", "PRIS"]);
    const updated = await service.quoteLossReasons.update(pris.id, { code: "PRIS", name: "För dyrt", active: false });
    expect(updated).toMatchObject({ code: "PRIS", name: "För dyrt", active: false });
    expect(await service.quoteLossReasons.findById(pris.id)).toMatchObject({ name: "För dyrt" });
  });

  it("refuses a duplicate code or name on create and on update to another row's values", async () => {
    const pris = await service.quoteLossReasons.create({ code: "PRIS", name: "Pris", active: true });
    await service.quoteLossReasons.create({ code: "LEVTID", name: "Leveranstid", active: true });
    await expect(service.quoteLossReasons.create({ code: "PRIS", name: "Annat", active: true })).rejects.toThrow(DuplicateRegisterEntryError);
    await expect(service.quoteLossReasons.create({ code: "NY", name: "Pris", active: true })).rejects.toThrow(DuplicateRegisterEntryError);
    await expect(service.quoteLossReasons.update(pris.id, { code: "LEVTID", name: "Pris", active: true })).rejects.toThrow(
      DuplicateRegisterEntryError
    );
    // Keeping its own code/name is fine.
    expect(await service.quoteLossReasons.update(pris.id, { code: "PRIS", name: "Pris", active: false })).toMatchObject({ active: false });
    await expect(service.quoteLossReasons.update(crypto.randomUUID(), { code: "X", name: "X", active: true })).rejects.toThrow(
      RegisterEntryNotFoundError
    );
  });

  it("reports usage by lost quotes and deletes an unused reason outright", async () => {
    const pris = await service.quoteLossReasons.create({ code: "PRIS", name: "Pris", active: true });
    expect(await service.quoteLossReasons.usage(pris.id)).toEqual({ total: 0, references: [] });
    await lostQuote(pris.id);
    await lostQuote(pris.id);
    expect(await service.quoteLossReasons.usage(pris.id)).toEqual({
      total: 2,
      references: [{ table: "sales_orders", label: "förlorade offerter", labelOne: "förlorad offert", count: 2 }],
    });
    const unused = await service.quoteLossReasons.create({ code: "SVAR", name: "Inget svar", active: true });
    await service.quoteLossReasons.remove(unused.id);
    expect((await service.quoteLossReasons.list()).map((r) => r.code)).toEqual(["PRIS"]);
  });

  it("a used reason needs a replacement of the same register; the lost quotes move to it", async () => {
    const pris = await service.quoteLossReasons.create({ code: "PRIS", name: "Pris", active: true });
    const annan = await service.quoteLossReasons.create({ code: "ANNAN", name: "Annan", active: true });
    const order = await lostQuote(pris.id);
    await expect(service.quoteLossReasons.remove(pris.id)).rejects.toThrow(RegisterEntryInUseError);
    await expect(service.quoteLossReasons.remove(pris.id, pris.id)).rejects.toThrow(InvalidReplacementError);
    // A payment term's id is not a förlustorsak.
    const term = await service.paymentTerms.create({ code: "30", name: "30 dagar" });
    await expect(service.quoteLossReasons.remove(pris.id, term.id)).rejects.toThrow(InvalidReplacementError);

    expect(await service.quoteLossReasons.remove(pris.id, annan.id)).toEqual({ moved: [{ table: "sales_orders", count: 1 }] });
    const [moved] = await db.select({ lostReasonId: salesOrders.lostReasonId }).from(salesOrders).where(eq(salesOrders.id, order.id));
    expect(moved!.lostReasonId).toBe(annan.id);
    expect(await db.select().from(quoteLossReasons).where(eq(quoteLossReasons.id, pris.id))).toEqual([]);
    await service.paymentTerms.remove(term.id);
  });
});

describe("förlustorsaker — routes", () => {
  async function login(email: string) {
    const res = await app.inject({ method: "POST", url: "/api/v1/auth/login", payload: { email, password: PASSWORD } });
    expect(res.statusCode).toBe(200);
    return `session=${res.cookies.find((c) => c.name === "session")!.value}`;
  }
  async function adminCookie() {
    const email = `admin-${crypto.randomUUID()}@example.com`;
    await authService.createUser({ email, password: PASSWORD, name: "Admin", role: "admin" });
    return login(email);
  }
  async function userCookie(permissions: string[]) {
    const [group] = await db
      .insert(permissionGroups)
      .values({ code: `QLR${crypto.randomUUID().slice(0, 6)}`, name: "Test", permissions })
      .returning();
    const email = `user-${crypto.randomUUID()}@example.com`;
    await authService.createUser({ email, password: PASSWORD, name: "Användare", role: "user", permissionGroupId: group!.id });
    return login(email);
  }

  it("Försäljning creates, updates and reads; another office menu only reads; the delete is admin", async () => {
    const sales = await userCookie(["forsaljning"]);
    const purchasing = await userCookie(["inkop"]);
    const admin = await adminCookie();

    const created = await app.inject({
      method: "POST",
      url: "/api/v1/quote-loss-reasons",
      headers: { cookie: sales },
      payload: { code: "pris", name: "Pris" },
    });
    expect(created.statusCode).toBe(201);
    const reason = created.json();
    expect(reason).toMatchObject({ code: "PRIS", name: "Pris", active: true });

    const duplicate = await app.inject({
      method: "POST",
      url: "/api/v1/quote-loss-reasons",
      headers: { cookie: sales },
      payload: { code: "PRIS", name: "Annat" },
    });
    expect(duplicate.statusCode).toBe(409);
    expect(duplicate.json().code).toBe("duplicate-register-entry");

    const patched = await app.inject({
      method: "PATCH",
      url: `/api/v1/quote-loss-reasons/${reason.id}`,
      headers: { cookie: sales },
      payload: { code: "PRIS", name: "Pris", active: false },
    });
    expect(patched.statusCode).toBe(200);
    expect(patched.json().active).toBe(false);

    expect((await app.inject({ url: "/api/v1/quote-loss-reasons", headers: { cookie: purchasing } })).statusCode).toBe(200);
    expect((await app.inject({ url: `/api/v1/quote-loss-reasons/${reason.id}/usage`, headers: { cookie: purchasing } })).json()).toEqual({
      total: 0,
      references: [],
    });
    expect(
      (
        await app.inject({
          method: "POST",
          url: "/api/v1/quote-loss-reasons",
          headers: { cookie: purchasing },
          payload: { code: "SVAR", name: "Inget svar" },
        })
      ).statusCode
    ).toBe(403);
    expect(
      (
        await app.inject({
          method: "PATCH",
          url: `/api/v1/quote-loss-reasons/${reason.id}`,
          headers: { cookie: purchasing },
          payload: { code: "PRIS", name: "Pris", active: true },
        })
      ).statusCode
    ).toBe(403);

    expect((await app.inject({ method: "DELETE", url: `/api/v1/quote-loss-reasons/${reason.id}`, headers: { cookie: sales } })).statusCode).toBe(403);
    expect((await app.inject({ method: "DELETE", url: `/api/v1/quote-loss-reasons/${reason.id}`, headers: { cookie: admin } })).statusCode).toBe(204);
    expect((await app.inject({ url: "/api/v1/quote-loss-reasons", headers: { cookie: sales } })).json()).toEqual([]);
  });

  it("the delete of a used reason answers 409 with the usage, and moves the quotes with replacementId", async () => {
    const admin = await adminCookie();
    const pris = await service.quoteLossReasons.create({ code: "PRIS", name: "Pris", active: true });
    const annan = await service.quoteLossReasons.create({ code: "ANNAN", name: "Annan", active: true });
    await lostQuote(pris.id);
    const refused = await app.inject({ method: "DELETE", url: `/api/v1/quote-loss-reasons/${pris.id}`, headers: { cookie: admin } });
    expect(refused.statusCode).toBe(409);
    expect(refused.json().usage.total).toBe(1);
    const moved = await app.inject({
      method: "DELETE",
      url: `/api/v1/quote-loss-reasons/${pris.id}`,
      headers: { cookie: admin },
      payload: { replacementId: annan.id },
    });
    expect(moved.statusCode).toBe(204);
  });
});

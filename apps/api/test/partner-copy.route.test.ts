import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { and, eq, sql } from "drizzle-orm";
import { auditLog, customerDeliveryAddresses, db, permissionGroups } from "@navet/db";
import { buildApp } from "../src/app.js";
import { createAuthService } from "../src/modules/auth/service/auth.service.js";
import { createAuthRepository } from "../src/modules/auth/repository/auth.repository.js";
import { createAuditRepository } from "../src/modules/system/repository/audit.repository.js";

// Kopiera leverantör till kund och tvärtom (packages/shared/src/partner-copy.ts):
// POST /customers/from-supplier and POST /suppliers/from-customer create a
// NEW partner on the other side from the card's own data, its contacts and
// delivery addresses — the terms, delivery days, prices, bank details and
// our numbers stay behind. The lists find a partner by organisationsnummer
// (the dialog's warning).

const TRUNCATE = sql`TRUNCATE customers, suppliers, audit_log, user_settings, users CASCADE`;
const DELETE_GROUPS = sql`DELETE FROM permission_groups WHERE code LIKE 'PCPY%'`;

const app = buildApp();
const authService = createAuthService(createAuthRepository(db), "unused", createAuditRepository(db));

beforeEach(async () => {
  await db.execute(TRUNCATE);
  await db.execute(DELETE_GROUPS);
});

afterAll(async () => {
  await db.execute(TRUNCATE);
  await db.execute(DELETE_GROUPS);
  await app.close();
});

async function login(permissions: string[], opts: { readOnly?: boolean } = {}) {
  const [group] = await db
    .insert(permissionGroups)
    .values({ code: `PCPY${crypto.randomUUID().slice(0, 8)}`, name: "Kopiera", permissions })
    .returning();
  const email = `pcpy-${crypto.randomUUID()}@example.com`;
  await authService.createUser({ email, password: "correcthorse", name: "T", role: "user", permissionGroupId: group!.id, readOnly: opts.readOnly });
  const res = await app.inject({ method: "POST", url: "/api/v1/auth/login", payload: { email, password: "correcthorse" } });
  return `session=${res.cookies.find((c) => c.name === "session")!.value}`;
}

function client(cookie: string) {
  return {
    get: (url: string) => app.inject({ method: "GET", url: `/api/v1${url}`, headers: { cookie } }),
    post: (url: string, payload: object) => app.inject({ method: "POST", url: `/api/v1${url}`, headers: { cookie }, payload }),
  };
}

// A supplier abroad with everything filled in — what goes across and what
// stays behind.
async function supplierWithEverything(cookie: string) {
  const api = client(cookie);
  const created = await api.post("/suppliers", {
    name: "Exempel Stål A/S",
    contactName: "Mette Exempel",
    email: "info@exempel-staal.example",
    phone: "+45 11 22 33 44",
    address: "Industrivej 1",
    postalCode: "8000",
    city: "Aarhus",
    country: "DK",
    orgNumber: "DK12345678",
    vatNumber: "DK12345678",
    currency: "EUR",
    language: "en",
    purchaseOrderEmail: "ordre@exempel-staal.example",
    ourCustomerNumber: "K-777",
    carrierCustomerNumber: "SPED-1",
    freightPaidByUsDefault: true,
    deliveryWeekdays: [2, 4],
  });
  expect(created.statusCode).toBe(201);
  const supplier = created.json();
  expect((await api.post(`/suppliers/${supplier.id}/contacts`, { name: "Mette Exempel", email: "mette@exempel-staal.example", phone: "11", isPrimary: true })).statusCode).toBe(201);
  expect((await api.post(`/suppliers/${supplier.id}/contacts`, { name: "Lars Exempel", mobile: "22", comment: "Lager" })).statusCode).toBe(201);
  expect((await api.post(`/suppliers/${supplier.id}/delivery-addresses`, { label: "Lager", address: "Havnevej 2", postalCode: "8000", city: "Aarhus", isDefault: true })).statusCode).toBe(201);
  expect((await api.post(`/suppliers/${supplier.id}/delivery-addresses`, { label: "Kontor", address: "Industrivej 1" })).statusCode).toBe(201);
  return supplier as { id: string; supplierNumber: string };
}

describe("Kopiera till kund — POST /customers/from-supplier", () => {
  it("creates a customer from the supplier's own data, contacts and delivery addresses — and nothing one-way", async () => {
    const both = await login(["forsaljning", "inkop"]);
    const api = client(both);
    const supplier = await supplierWithEverything(both);

    const res = await api.post("/customers/from-supplier", { supplierId: supplier.id });
    expect(res.statusCode).toBe(201);
    const customer = res.json();
    expect(customer).toMatchObject({
      name: "Exempel Stål A/S",
      contactName: "Mette Exempel",
      email: "info@exempel-staal.example",
      phone: "+45 11 22 33 44",
      address: "Industrivej 1",
      postalCode: "8000",
      city: "Aarhus",
      country: "DK",
      orgNumber: "DK12345678",
      vatNumber: "DK12345678",
      currency: "EUR",
      language: "en",
      active: true,
      // One direction only: our numbers, the carrier account, fixed days.
      ourSupplierNumber: null,
      carrierCustomerNumber: null,
      paymentTermId: null,
      deliveryTermId: null,
      carrierId: null,
      deliveryWeekdays: [],
      invoiceEmail: null,
    });
    expect(customer.customerNumber).toMatch(/\S/);

    const contacts = (await api.get(`/customers/${customer.id}/contacts`)).json();
    expect(contacts.map((c: { name: string; isPrimary: boolean; email: string | null; mobile: string | null; comment: string | null }) => [c.name, c.isPrimary, c.email, c.mobile, c.comment])).toEqual([
      ["Mette Exempel", true, "mette@exempel-staal.example", null, null],
      ["Lars Exempel", false, null, "22", "Lager"],
    ]);
    const addresses = (await api.get(`/customers/${customer.id}/delivery-addresses`)).json();
    // A supplier's address has no country — the customer's gets the supplier's.
    expect(addresses.map((a: { label: string; address: string; country: string; isDefault: boolean }) => [a.label, a.address, a.country, a.isDefault])).toEqual([
      ["Lager", "Havnevej 2", "DK", true],
      ["Kontor", "Industrivej 1", "DK", false],
    ]);

    // The supplier is untouched, and the copy is in the customer's history.
    expect((await api.get(`/suppliers/${supplier.id}/contacts`)).json()).toHaveLength(2);
    const [logged] = await db.select().from(auditLog).where(and(eq(auditLog.entityType, "customer"), eq(auditLog.action, "copied_from_supplier")));
    expect(logged).toMatchObject({ entityId: customer.id });
    expect(logged!.detail).toMatchObject({ customerNumber: customer.customerNumber, supplierId: supplier.id, supplierNumber: supplier.supplierNumber, supplierName: "Exempel Stål A/S" });
  });

  it("takes a typed number, refuses a taken one and an unknown supplier", async () => {
    const both = await login(["forsaljning", "inkop"]);
    const api = client(both);
    const supplier = await supplierWithEverything(both);

    const typed = await api.post("/customers/from-supplier", { supplierId: supplier.id, customerNumber: " K-9001 " });
    expect([typed.statusCode, typed.json().customerNumber]).toEqual([201, "K-9001"]);
    const taken = await api.post("/customers/from-supplier", { supplierId: supplier.id, customerNumber: "K-9001" });
    expect([taken.statusCode, taken.json().code]).toEqual([409, "duplicate-customer-number"]);
    // Nothing of the refused copy stays (one customer, its two contacts).
    expect((await api.get("/customers")).json().total).toBe(1);

    const unknown = await api.post("/customers/from-supplier", { supplierId: crypto.randomUUID() });
    expect([unknown.statusCode, unknown.json().code]).toEqual([404, "supplier-not-found"]);
    const extra = await api.post("/customers/from-supplier", { supplierId: supplier.id, name: "Annat" });
    expect(extra.statusCode).toBe(400);
  });

  it("is Försäljning's to do — Inköp alone and a read-only account are refused", async () => {
    const both = await login(["forsaljning", "inkop"]);
    const supplier = await supplierWithEverything(both);
    const purchaser = await login(["inkop"]);
    expect((await client(purchaser).post("/customers/from-supplier", { supplierId: supplier.id })).statusCode).toBe(403);
    const seller = await login(["forsaljning"]);
    expect((await client(seller).post("/customers/from-supplier", { supplierId: supplier.id })).statusCode).toBe(201);
    const readOnly = await login(["forsaljning"], { readOnly: true });
    const refused = await client(readOnly).post("/customers/from-supplier", { supplierId: supplier.id });
    expect([refused.statusCode, refused.json().code]).toEqual([403, "read-only-account"]);
  });
});

describe("Kopiera till leverantör — POST /suppliers/from-customer", () => {
  it("creates a supplier from the customer's own data, contacts and delivery addresses — not its one-off addresses", async () => {
    const both = await login(["forsaljning", "inkop"]);
    const api = client(both);
    const created = await api.post("/customers", {
      name: "Exempelkunden AB",
      contactName: "Anna Exempel",
      email: "info@exempelkunden.example",
      phone: "031-123456",
      address: "Storgatan 1",
      postalCode: "411 01",
      city: "Göteborg",
      orgNumber: "556000-0000",
      vatNumber: "SE556000000001",
      website: "www.exempelkunden.example",
      invoiceEmail: "faktura@exempelkunden.example",
      ourSupplierNumber: "L-55",
      discountPercent: 5,
    });
    expect(created.statusCode).toBe(201);
    const customer = created.json();
    expect((await api.post(`/customers/${customer.id}/contacts`, { name: "Anna Exempel", isPrimary: true })).statusCode).toBe(201);
    expect((await api.post(`/customers/${customer.id}/delivery-addresses`, { label: "Oslo", address: "Kaigata 3", city: "Oslo", country: "NO", isDefault: true })).statusCode).toBe(201);
    // An engångsadress belongs to one order, not to the customer.
    await db.insert(customerDeliveryAddresses).values({ customerId: customer.id, label: "Engång", address: "Tillfällig väg 9", oneOff: true });

    const res = await api.post("/suppliers/from-customer", { customerId: customer.id });
    expect(res.statusCode).toBe(201);
    const supplier = res.json();
    expect(supplier).toMatchObject({
      name: "Exempelkunden AB",
      contactName: "Anna Exempel",
      email: "info@exempelkunden.example",
      phone: "031-123456",
      address: "Storgatan 1",
      postalCode: "411 01",
      city: "Göteborg",
      country: "SE",
      orgNumber: "556000-0000",
      vatNumber: "SE556000000001",
      currency: "SEK",
      language: "sv",
      ourCustomerNumber: null,
      purchaseOrderEmail: null,
      paymentMethod: null,
      deliveryWeekdays: [],
    });
    expect(supplier.supplierNumber).toMatch(/\S/);
    expect((await api.get(`/suppliers/${supplier.id}/contacts`)).json().map((c: { name: string; isPrimary: boolean }) => [c.name, c.isPrimary])).toEqual([["Anna Exempel", true]]);
    // A supplier's address has no country of its own.
    expect(
      (await api.get(`/suppliers/${supplier.id}/delivery-addresses`)).json().map((a: { label: string; address: string; city: string; isDefault: boolean }) => [a.label, a.address, a.city, a.isDefault])
    ).toEqual([["Oslo", "Kaigata 3", "Oslo", true]]);

    const [logged] = await db.select().from(auditLog).where(and(eq(auditLog.entityType, "supplier"), eq(auditLog.action, "copied_from_customer")));
    expect(logged).toMatchObject({ entityId: supplier.id });
    expect(logged!.detail).toMatchObject({ supplierNumber: supplier.supplierNumber, customerId: customer.id, customerNumber: customer.customerNumber, customerName: "Exempelkunden AB" });
  });

  it("takes a typed number, refuses a taken one, an unknown customer, Försäljning alone and a read-only account", async () => {
    const both = await login(["forsaljning", "inkop"]);
    const api = client(both);
    const customer = (await api.post("/customers", { name: "Exempelkunden AB" })).json();

    const typed = await api.post("/suppliers/from-customer", { customerId: customer.id, supplierNumber: "L-9001" });
    expect([typed.statusCode, typed.json().supplierNumber]).toEqual([201, "L-9001"]);
    const taken = await api.post("/suppliers/from-customer", { customerId: customer.id, supplierNumber: "L-9001" });
    expect([taken.statusCode, taken.json().code]).toEqual([409, "duplicate-supplier-number"]);
    const unknown = await api.post("/suppliers/from-customer", { customerId: crypto.randomUUID() });
    expect([unknown.statusCode, unknown.json().code]).toEqual([404, "customer-not-found"]);

    const seller = await login(["forsaljning"]);
    expect((await client(seller).post("/suppliers/from-customer", { customerId: customer.id })).statusCode).toBe(403);
    const purchaser = await login(["inkop"]);
    expect((await client(purchaser).post("/suppliers/from-customer", { customerId: customer.id })).statusCode).toBe(201);
    const readOnly = await login(["inkop"], { readOnly: true });
    expect((await client(readOnly).post("/suppliers/from-customer", { customerId: customer.id })).statusCode).toBe(403);
  });
});

describe("the lists find a partner by organisationsnummer", () => {
  it("searches customers and suppliers on org_number", async () => {
    const both = await login(["forsaljning", "inkop"]);
    const api = client(both);
    await api.post("/customers", { name: "Kund Ett AB", orgNumber: "556111-2222" });
    await api.post("/customers", { name: "Kund Två AB", orgNumber: "556333-4444" });
    await api.post("/suppliers", { name: "Leverantör Ett AB", orgNumber: "556111-2222" });

    const customers = (await api.get("/customers?search=556111-2222")).json();
    expect(customers.rows.map((r: { name: string }) => r.name)).toEqual(["Kund Ett AB"]);
    const suppliers = (await api.get("/suppliers?search=556111")).json();
    expect(suppliers.rows.map((r: { name: string }) => r.name)).toEqual(["Leverantör Ett AB"]);
  });
});

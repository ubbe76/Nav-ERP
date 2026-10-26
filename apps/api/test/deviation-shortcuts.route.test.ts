import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { and, eq, sql } from "drizzle-orm";
import { db, deviationLinks, invoices, manufacturingOrders, permissionGroups, purchaseOrders, salesOrders } from "@navet/db";
import { buildApp } from "../src/app.js";
import { createAuthRepository } from "../src/modules/auth/repository/auth.repository.js";
import { createAuthService } from "../src/modules/auth/service/auth.service.js";
import { createAuditRepository } from "../src/modules/system/repository/audit.repository.js";

// Avvikelsernas genvägar: the optional deviationId on POST /invoices/:id/credit,
// /quotes, /purchase-orders and /manufacturing-orders writes deviation_links
// in the document's own create transaction — a refused link (closed case,
// wrong type, another counterparty) leaves no document behind — and needs
// Kvalitet on top of the document's own rule. All data made up.

const authService = createAuthService(createAuthRepository(db), "unused", createAuditRepository(db));
const PASSWORD = "correcthorsebattery";
const TRUNCATE = sql`TRUNCATE deviations, invoice_rows, invoices, sales_order_rows, sales_orders, customers, purchase_order_rows, purchase_orders, suppliers, mo_operations, manufacturing_orders, articles, user_settings, audit_log, users CASCADE`;
const DELETE_GROUPS = sql`DELETE FROM permission_groups WHERE code LIKE 'AVG%'`;

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

async function cookieWith(permissions: string[] | "admin", name: string) {
  const email = `${name.toLowerCase()}-${crypto.randomUUID()}@example.com`;
  if (permissions === "admin") {
    await authService.createUser({ email, password: PASSWORD, name, role: "admin" });
  } else {
    const [group] = await db
      .insert(permissionGroups)
      .values({ code: `AVG${crypto.randomUUID().slice(0, 6)}`, name, permissions })
      .returning();
    await authService.createUser({ email, password: PASSWORD, name, role: "user", permissionGroupId: group!.id });
  }
  const res = await app.inject({ method: "POST", url: "/api/v1/auth/login", payload: { email, password: PASSWORD } });
  return `session=${res.cookies.find((c) => c.name === "session")!.value}`;
}

function api(cookie: string) {
  return {
    get: (url: string) => app.inject({ method: "GET", url: `/api/v1${url}`, headers: { cookie } }),
    post: (url: string, payload?: unknown) => app.inject({ method: "POST", url: `/api/v1${url}`, headers: { cookie }, payload }),
    patch: (url: string, payload?: unknown) => app.inject({ method: "PATCH", url: `/api/v1${url}`, headers: { cookie }, payload }),
  };
}
type Api = ReturnType<typeof api>;

async function setup(admin: Api) {
  const suffix = crypto.randomUUID().slice(0, 6);
  const article = (await admin.post("/articles", { articleNumber: `GV-${suffix}`, name: "Diskbänk", type: "manufactured" })).json();
  const customer = (await admin.post("/customers", { name: "Exempelkrogen AB" })).json();
  const otherCustomer = (await admin.post("/customers", { name: "Hotell Exempel AB" })).json();
  const supplier = (await admin.post("/suppliers", { name: "Exempel Stål AB" })).json();
  const complaint = (await admin.post("/deviations", { type: "customer", title: "Skadad", customerId: customer.id, articleId: article.id, quantity: 1 })).json();
  const supplierCase = (await admin.post("/deviations", { type: "supplier", title: "Fel antal", supplierId: supplier.id })).json();
  const internal = (await admin.post("/deviations", { type: "internal", title: "Omarbete", correctiveAction: "Klar" })).json();
  const closed = (await admin.post("/deviations", { type: "internal", title: "Avslutad", correctiveAction: "Klar" })).json();
  expect((await admin.post(`/deviations/${closed.id}/close`, {})).statusCode).toBe(200);
  return { article, customer, otherCustomer, supplier, complaint, supplierCase, internal, closed };
}

const linksOf = (deviationId: string) => db.select().from(deviationLinks).where(eq(deviationLinks.deviationId, deviationId));

describe("genvägarnas deviationId", () => {
  it("Skapa kreditfaktura: the credit note and its link in one transaction", async () => {
    const admin = api(await cookieWith("admin", "Admin"));
    const s = await setup(admin);
    const [source] = await db
      .insert(invoices)
      .values({ customerId: s.customer.id, type: "invoice", status: "issued", invoiceNumber: `F-${crypto.randomUUID().slice(0, 5)}` })
      .returning();
    const credits = () => db.select().from(invoices).where(and(eq(invoices.type, "credit"), eq(invoices.creditedInvoiceId, source!.id)));

    // Refused: a closed case, a supplier case — no credit note is left behind.
    const closed = await admin.post(`/invoices/${source!.id}/credit`, { rows: [], deviationId: s.closed.id });
    expect(closed.statusCode).toBe(409);
    expect(closed.json().code).toBe("deviation-link-not-allowed");
    expect((await admin.post(`/invoices/${source!.id}/credit`, { rows: [], deviationId: s.supplierCase.id })).statusCode).toBe(409);
    expect(await credits()).toHaveLength(0);

    // Försäljning without Kvalitet may credit, but not link.
    const sales = api(await cookieWith(["forsaljning"], "Saljare"));
    expect((await sales.post(`/invoices/${source!.id}/credit`, { rows: [], deviationId: s.complaint.id })).statusCode).toBe(403);
    expect(await credits()).toHaveLength(0);

    const created = await admin.post(`/invoices/${source!.id}/credit`, { rows: [], deviationId: s.complaint.id });
    expect(created.statusCode).toBe(201);
    expect(await linksOf(s.complaint.id)).toEqual([
      expect.objectContaining({ documentType: "credit_invoice", documentId: created.json().id }),
    ]);
    // The credit note's own card finds the case (invoiceId matches a linked kreditfaktura).
    const onCredit = (await admin.get(`/deviations?invoiceId=${created.json().id}&status=all`)).json();
    expect(onCredit.rows.map((r: { id: string }) => r.id)).toEqual([s.complaint.id]);
    const card = (await admin.get(`/deviations/${s.complaint.id}`)).json();
    expect(card.links[0]).toMatchObject({ documentType: "credit_invoice", documentStatus: "draft" });
    expect(card.events.map((e: { event: string }) => e.event)).toContain("link_added");
  });

  it("Skapa ersättningsorder: POST /quotes with deviationId — another customer is refused and no order is created", async () => {
    const admin = api(await cookieWith("admin", "Admin"));
    const s = await setup(admin);
    const before = (await db.select().from(salesOrders)).length;
    const wrong = await admin.post("/quotes", {
      customerId: s.otherCustomer.id,
      confirm: true,
      deviationId: s.complaint.id,
      rows: [{ articleId: s.article.id, quantity: 1, unitPrice: 0 }],
    });
    expect(wrong.statusCode).toBe(409);
    expect(wrong.json().code).toBe("deviation-link-not-allowed");
    expect(await db.select().from(salesOrders)).toHaveLength(before);

    const ok = await admin.post("/quotes", {
      customerId: s.customer.id,
      confirm: true,
      deviationId: s.complaint.id,
      note: "Ersättning",
      rows: [{ articleId: s.article.id, quantity: 1, unitPrice: 0 }],
    });
    expect(ok.statusCode).toBe(201);
    expect(ok.json().order.status).toBe("confirmed");
    expect(await linksOf(s.complaint.id)).toEqual([expect.objectContaining({ documentType: "sales_order", documentId: ok.json().order.id })]);
  });

  it("Skapa inköpsorder: only a supplier case of the same supplier", async () => {
    const admin = api(await cookieWith("admin", "Admin"));
    const s = await setup(admin);
    const wrongType = await admin.post("/purchase-orders", { supplierId: s.supplier.id, deviationId: s.internal.id });
    expect(wrongType.statusCode).toBe(409);
    expect(await db.select().from(purchaseOrders)).toHaveLength(0);
    const ok = await admin.post("/purchase-orders", { supplierId: s.supplier.id, deviationId: s.supplierCase.id });
    expect(ok.statusCode).toBe(201);
    expect(await linksOf(s.supplierCase.id)).toEqual([expect.objectContaining({ documentType: "purchase_order", documentId: ok.json().id })]);
    // The new IO's Avvikelser section finds the case through the link.
    const onOrder = (await admin.get(`/deviations?purchaseOrderId=${ok.json().id}&status=all`)).json();
    expect(onOrder.rows.map((r: { id: string }) => r.id)).toEqual([s.supplierCase.id]);
    // Inköp alone: 403, nothing created.
    const purchase = api(await cookieWith(["inkop"], "Inkopare"));
    expect((await purchase.post("/purchase-orders", { supplierId: s.supplier.id, deviationId: s.supplierCase.id })).statusCode).toBe(403);
    expect(await db.select().from(purchaseOrders)).toHaveLength(1);
  });

  it("Skapa tillverkningsorder: internal or customer cases; a closed case leaves no TO", async () => {
    const admin = api(await cookieWith("admin", "Admin"));
    const s = await setup(admin);
    const closed = await admin.post("/manufacturing-orders", { articleId: s.article.id, quantity: 2, deviationId: s.closed.id });
    expect(closed.statusCode).toBe(409);
    expect(closed.json().code).toBe("deviation-link-not-allowed");
    expect((await admin.post("/manufacturing-orders", { articleId: s.article.id, quantity: 2, deviationId: s.supplierCase.id })).statusCode).toBe(409);
    expect(await db.select().from(manufacturingOrders)).toHaveLength(0);

    const ok = await admin.post("/manufacturing-orders", { articleId: s.article.id, quantity: 2, deviationId: s.internal.id });
    expect(ok.statusCode).toBe(201);
    expect(await linksOf(s.internal.id)).toEqual([expect.objectContaining({ documentType: "manufacturing_order", documentId: ok.json().id })]);
    const onMo = (await admin.get(`/deviations?manufacturingOrderId=${ok.json().id}&status=all`)).json();
    expect(onMo.rows.map((r: { id: string }) => r.id)).toEqual([s.internal.id]);
    const forComplaint = await admin.post("/manufacturing-orders", { articleId: s.article.id, quantity: 1, deviationId: s.complaint.id });
    expect(forComplaint.statusCode).toBe(201);
    // Kvalitet + Tillverkning together may link; Tillverkning alone may not.
    const both = api(await cookieWith(["tillverkning", "kvalitet"], "Bada"));
    expect((await both.post("/manufacturing-orders", { articleId: s.article.id, quantity: 1, deviationId: s.internal.id })).statusCode).toBe(201);
    const prod = api(await cookieWith(["tillverkning"], "Produktion"));
    expect((await prod.post("/manufacturing-orders", { articleId: s.article.id, quantity: 1, deviationId: s.internal.id })).statusCode).toBe(403);
    expect((await prod.post("/manufacturing-orders", { articleId: s.article.id, quantity: 1 })).statusCode).toBe(201);
  });
});

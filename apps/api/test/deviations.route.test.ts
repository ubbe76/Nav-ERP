import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import { db, deviationEvents, invoiceRows, invoices, permissionGroups, supplierInvoices, vatCodes } from "@navet/db";
import { eq } from "drizzle-orm";
import { buildApp } from "../src/app.js";
import { createAuthRepository } from "../src/modules/auth/repository/auth.repository.js";
import { createAuthService } from "../src/modules/auth/service/auth.service.js";
import { createAuditRepository } from "../src/modules/system/repository/audit.repository.js";
import { pdfText } from "./helpers/pdf.js";

// Reklamationer och avvikelser through the real app: the register's routes
// and their response shapes (the web is built against them), the link
// checks, the status flow with Avsluta's requirements, the costs with the
// derived amounts (drafts never count), Koppla dokument, the files, the
// history, the PDF, the CSV, the alert and the permissions (office reads,
// Kvalitet writes). All data made up.

const authService = createAuthService(createAuthRepository(db), "unused", createAuditRepository(db));
const PASSWORD = "correcthorsebattery";
const TRUNCATE = sql`TRUNCATE deviations, deviation_reasons, email_log, invoice_rows, invoices, sales_order_rows, sales_orders, customers, purchase_order_rows, purchase_orders, supplier_invoices, suppliers, mo_operations, manufacturing_orders, articles, user_settings, audit_log, users CASCADE`;
const DELETE_GROUPS = sql`DELETE FROM permission_groups WHERE code LIKE 'AVV%'`;

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

async function login(email: string) {
  const res = await app.inject({ method: "POST", url: "/api/v1/auth/login", payload: { email, password: PASSWORD } });
  expect(res.statusCode).toBe(200);
  return `session=${res.cookies.find((c) => c.name === "session")!.value}`;
}

async function cookieWith(permissions: string[] | "admin", name: string) {
  const email = `${name.toLowerCase()}-${crypto.randomUUID()}@example.com`;
  if (permissions === "admin") {
    await authService.createUser({ email, password: PASSWORD, name, role: "admin" });
  } else {
    const [group] = await db
      .insert(permissionGroups)
      .values({ code: `AVV${crypto.randomUUID().slice(0, 6)}`, name, permissions })
      .returning();
    await authService.createUser({ email, password: PASSWORD, name, role: "user", permissionGroupId: group!.id });
  }
  return login(email);
}

function api(cookie: string) {
  return {
    get: (url: string) => app.inject({ method: "GET", url: `/api/v1${url}`, headers: { cookie } }),
    post: (url: string, payload?: unknown) => app.inject({ method: "POST", url: `/api/v1${url}`, headers: { cookie }, payload }),
    patch: (url: string, payload?: unknown) => app.inject({ method: "PATCH", url: `/api/v1${url}`, headers: { cookie }, payload }),
    delete: (url: string, payload?: unknown) => app.inject({ method: "DELETE", url: `/api/v1${url}`, headers: { cookie }, payload }),
    upload: (url: string, filename: string, contentType: string, content: Buffer) => {
      const boundary = `----avv${crypto.randomUUID()}`;
      const payload = Buffer.concat([
        Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${filename}"\r\nContent-Type: ${contentType}\r\n\r\n`),
        content,
        Buffer.from(`\r\n--${boundary}--\r\n`),
      ]);
      return app.inject({
        method: "POST",
        url: `/api/v1${url}`,
        headers: { cookie, "content-type": `multipart/form-data; boundary=${boundary}` },
        payload,
      });
    },
  };
}

type Api = ReturnType<typeof api>;

const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(64, 1)]);

const todayStockholm = () => new Intl.DateTimeFormat("sv-SE", { timeZone: "Europe/Stockholm" }).format(new Date());

async function fixtures(admin: Api) {
  const suffix = crypto.randomUUID().slice(0, 6);
  const article = (await admin.post("/articles", { articleNumber: `DB-${suffix}`, name: "Diskbänk 1200", type: "purchased" })).json();
  const other = (await admin.post("/articles", { articleNumber: `UR-${suffix}`, name: "Underrede", type: "purchased" })).json();
  const customer = (await admin.post("/customers", { name: "Restaurang Exempelkrogen AB" })).json();
  const otherCustomer = (await admin.post("/customers", { name: "Hotell Exempel AB" })).json();
  const supplier = (await admin.post("/suppliers", { name: "Exempel Stålhandel AB" })).json();
  const quote = await admin.post("/quotes", { customerId: customer.id, confirm: true, rows: [{ articleId: article.id, quantity: 5, unitPrice: 100 }] });
  expect(quote.statusCode).toBe(201);
  const otherQuote = await admin.post("/quotes", { customerId: otherCustomer.id, confirm: true, rows: [{ articleId: article.id, quantity: 1, unitPrice: 100 }] });
  const po = (await admin.post("/purchase-orders", { supplierId: supplier.id })).json();
  const poRow = await admin.post(`/purchase-orders/${po.id}/rows`, { articleId: article.id, quantity: 10, unitPrice: 50 });
  expect(poRow.statusCode).toBe(201);
  const reasons = {
    transport: (
      await admin.post("/deviation-reasons", { code: "TRANSP", name: "Transportskada", appliesCustomer: true, appliesSupplier: true })
    ).json(),
    machine: (await admin.post("/deviation-reasons", { code: "MASKIN", name: "Maskinfel", appliesInternal: true })).json(),
  };
  return {
    article,
    other,
    customer,
    otherCustomer,
    supplier,
    order: quote.json().order,
    orderRow: quote.json().rows[0],
    otherOrder: otherQuote.json().order,
    po,
    poRowId: (poRow.json().id ?? poRow.json().row?.id) as string,
    reasons,
  };
}

describe("avvikelser: skapa, läsa och lista", () => {
  it("creates a kundreklamation from a KO row — the order and the article are filled in from the row", async () => {
    const admin = api(await cookieWith("admin", "Admin"));
    const f = await fixtures(admin);
    const created = await admin.post("/deviations", {
      type: "customer",
      title: "Repad diskbänk",
      description: "Repor på ovansidan vid leverans",
      customerId: f.customer.id,
      salesOrderRowId: f.orderRow.id,
      quantity: 2,
      reasonId: f.reasons.transport.id,
      counterpartyReference: "REK-77",
      dueDate: "2020-01-01",
    });
    expect(created.statusCode).toBe(201);
    const body = created.json();
    expect(body).toMatchObject({
      deviationNumber: expect.stringMatching(/^AV-\d+$/),
      type: "customer",
      status: "registered",
      title: "Repad diskbänk",
      reportedDate: todayStockholm(),
      customerId: f.customer.id,
      customerName: "Restaurang Exempelkrogen AB",
      counterpartyName: "Restaurang Exempelkrogen AB",
      salesOrderId: f.order.id,
      salesOrderNumber: f.order.orderNumber,
      salesOrderRowId: f.orderRow.id,
      articleId: f.article.id,
      articleNumber: f.article.articleNumber,
      quantity: 2,
      reasonName: "Transportskada",
      counterpartyReference: "REK-77",
      overdue: true,
      editable: true,
      allowedTransitions: ["start", "close", "cancel"],
      closeRequirementsMissing: ["correctiveAction", "decision"],
      netCost: 0,
      costs: { rows: [], derived: [], totalCosts: 0, totalRecovery: 0, netCost: 0 },
      links: [],
      files: [],
    });
    expect(body.events.map((e: { event: string }) => e.event)).toEqual(["created"]);

    const internal = await admin.post("/deviations", { type: "internal", title: "Fel bockvinkel", reasonId: f.reasons.machine.id });
    expect(internal.statusCode).toBe(201);

    // The list: open by default, filters, search, overdue.
    const list = await admin.get("/deviations");
    expect(list.statusCode).toBe(200);
    expect(list.json().total).toBe(2);
    expect((await admin.get(`/deviations?type=customer`)).json().rows.map((r: { title: string }) => r.title)).toEqual(["Repad diskbänk"]);
    expect((await admin.get(`/deviations?salesOrderId=${f.order.id}`)).json().total).toBe(1);
    expect((await admin.get(`/deviations?customerId=${f.otherCustomer.id}`)).json().total).toBe(0);
    expect((await admin.get(`/deviations?articleId=${f.article.id}`)).json().total).toBe(1);
    expect((await admin.get(`/deviations?reasonId=${f.reasons.machine.id}`)).json().total).toBe(1);
    expect((await admin.get(`/deviations?search=REK-77`)).json().total).toBe(1);
    expect((await admin.get(`/deviations?search=Exempelkrogen`)).json().total).toBe(1);
    expect((await admin.get(`/deviations?overdue=1`)).json().rows.map((r: { title: string }) => r.title)).toEqual(["Repad diskbänk"]);
    expect((await admin.get(`/deviations?from=2000-01-01&to=2000-12-31`)).json().total).toBe(0);
    const row = list.json().rows.find((r: { title: string }) => r.title === "Repad diskbänk");
    expect(row).toMatchObject({ netCost: 0, overdue: true, unitCode: "st", reasonCode: "TRANSP", counterpartyName: "Restaurang Exempelkrogen AB" });

    // Cancelled cases leave the default list but not status=all.
    await admin.post(`/deviations/${internal.json().id}/cancel`, { reason: "Dubblett" });
    expect((await admin.get("/deviations")).json().total).toBe(1);
    expect((await admin.get("/deviations?status=all")).json().total).toBe(2);
    expect((await admin.get("/deviations?status=cancelled")).json().total).toBe(1);
    expect((await admin.get("/deviations?status=bogus")).statusCode).toBe(400);

    // The CSV: same selection, Swedish header.
    const csv = await admin.get("/deviations/csv?status=all");
    expect(csv.statusCode).toBe(200);
    expect(csv.headers["content-type"]).toContain("text/csv");
    expect(csv.body).toContain("Nr;Datum;Typ;Rubrik;Motpart");
    expect(csv.body).toContain(body.deviationNumber);
    expect(csv.body).toContain("Kundreklamation");

    expect((await admin.get(`/deviations/${crypto.randomUUID()}`)).json().code).toBe("deviation-not-found");
  });
});

describe("avvikelser: kopplingskontrollerna", () => {
  it("refuses what does not belong together (400 deviation-link-mismatch with the field)", async () => {
    const admin = api(await cookieWith("admin", "Admin"));
    const f = await fixtures(admin);
    const refuse = async (payload: Record<string, unknown>, field: string) => {
      const res = await admin.post("/deviations", { title: "Test", ...payload });
      expect(res.statusCode, JSON.stringify(res.json())).toBe(400);
      expect(res.json()).toMatchObject({ code: "deviation-link-mismatch", field });
    };
    // The KO is another customer's.
    await refuse({ type: "customer", customerId: f.customer.id, salesOrderId: f.otherOrder.id }, "salesOrderId");
    // A KO on a supplier case.
    await refuse({ type: "supplier", supplierId: f.supplier.id, salesOrderId: f.order.id }, "salesOrderId");
    // The customer is missing on a complaint.
    await refuse({ type: "customer" }, "customerId");
    // The IO is the supplier's — but the row's article is not the chosen one.
    await refuse({ type: "supplier", supplierId: f.supplier.id, purchaseOrderRowId: f.poRowId, articleId: f.other.id }, "purchaseOrderRowId");
    // An IO on an internal case.
    await refuse({ type: "internal", purchaseOrderId: f.po.id }, "purchaseOrderId");

    // The reason must apply to the type.
    const reason = await admin.post("/deviations", { type: "internal", title: "Test", reasonId: f.reasons.transport.id });
    expect(reason.statusCode).toBe(400);
    expect(reason.json().code).toBe("deviation-reason-not-applicable");

    // A consistent supplier case: the IO comes from the row.
    const ok = await admin.post("/deviations", { type: "supplier", title: "Fel antal", supplierId: f.supplier.id, purchaseOrderRowId: f.poRowId });
    expect(ok.statusCode).toBe(201);
    expect(ok.json()).toMatchObject({ purchaseOrderId: f.po.id, purchaseOrderNumber: f.po.orderNumber, articleId: f.article.id, supplierName: "Exempel Stålhandel AB" });

    // PATCH re-checks the merged case.
    const patched = await admin.patch(`/deviations/${ok.json().id}`, { purchaseOrderRowId: null, articleId: f.other.id });
    expect(patched.statusCode).toBe(200);
    expect(patched.json()).toMatchObject({ purchaseOrderRowId: null, purchaseOrderId: f.po.id, articleId: f.other.id });
    expect((await admin.patch(`/deviations/${ok.json().id}`, { decision: "accepted" })).statusCode).toBe(200);
    const internal = (await admin.post("/deviations", { type: "internal", title: "Intern" })).json();
    const decision = await admin.patch(`/deviations/${internal.id}`, { decision: "accepted" });
    expect(decision.statusCode).toBe(400);
    expect(decision.json()).toMatchObject({ code: "deviation-link-mismatch", field: "decision" });
  });
});

describe("avvikelser: statusflödet", () => {
  it("Börja utreda → Avsluta (krav) → Öppna igen → Makulera, with the history", async () => {
    const admin = api(await cookieWith("admin", "Admin"));
    const f = await fixtures(admin);
    const c = (await admin.post("/deviations", { type: "customer", title: "Bucklig", customerId: f.customer.id })).json();

    const started = await admin.post(`/deviations/${c.id}/start`);
    expect(started.statusCode).toBe(200);
    expect(started.json()).toMatchObject({ status: "investigating", allowedTransitions: ["close", "cancel"] });
    expect((await admin.post(`/deviations/${c.id}/start`)).json().code).toBe("invalid-status-transition");

    const refused = await admin.post(`/deviations/${c.id}/close`, {});
    expect(refused.statusCode).toBe(409);
    expect(refused.json()).toMatchObject({ code: "deviation-close-requirements", missing: ["correctiveAction", "decision"] });

    await admin.patch(`/deviations/${c.id}`, { correctiveAction: "Ny diskbänk skickas", causeAnalysis: "Dålig emballering" });
    const stillMissing = await admin.post(`/deviations/${c.id}/close`, {});
    expect(stillMissing.json()).toMatchObject({ code: "deviation-close-requirements", missing: ["decision"] });

    const closed = await admin.post(`/deviations/${c.id}/close`, { decision: "accepted" });
    expect(closed.statusCode).toBe(200);
    expect(closed.json()).toMatchObject({ status: "closed", decision: "accepted", closedAt: expect.any(String), closedByName: "Admin", editable: false, allowedTransitions: ["reopen"] });

    // Closed: no edits, costs, links or files until Öppna igen.
    expect((await admin.patch(`/deviations/${c.id}`, { title: "Ny" })).json().code).toBe("deviation-not-editable");
    expect((await admin.post(`/deviations/${c.id}/costs`, { kind: "material", amount: 10 })).json().code).toBe("deviation-not-editable");
    expect((await admin.post(`/deviations/${c.id}/cancel`, { reason: "x" })).json().code).toBe("invalid-status-transition");

    const reopened = await admin.post(`/deviations/${c.id}/reopen`);
    expect(reopened.json()).toMatchObject({ status: "investigating", closedAt: null, closedByName: null, decision: "accepted", correctiveAction: "Ny diskbänk skickas" });

    expect((await admin.post(`/deviations/${c.id}/cancel`, {})).statusCode).toBe(400);
    const cancelled = await admin.post(`/deviations/${c.id}/cancel`, { reason: "Kunden drog tillbaka" });
    expect(cancelled.json()).toMatchObject({ status: "cancelled", cancelReason: "Kunden drog tillbaka", allowedTransitions: [] });
    expect((await admin.post(`/deviations/${c.id}/reopen`)).json().code).toBe("invalid-status-transition");

    const events = cancelled.json().events as { event: string; detail: Record<string, unknown> }[];
    expect(events.map((e) => e.event)).toEqual(["created", "status_changed", "updated", "status_changed", "status_changed", "status_changed"]);
    expect(events[2]!.detail).toEqual({
      changes: {
        causeAnalysis: { before: null, after: "Dålig emballering" },
        correctiveAction: { before: null, after: "Ny diskbänk skickas" },
      },
    });
    expect(events[3]!.detail).toMatchObject({ action: "close", from: "investigating", to: "closed", decision: "accepted" });
    expect(events[5]!.detail).toMatchObject({ action: "cancel", reason: "Kunden drog tillbaka" });

    // An internal case closes from Registrerad with only Åtgärd.
    const internal = (await admin.post("/deviations", { type: "internal", title: "Spån i fixtur", correctiveAction: "Rengjord" })).json();
    expect((await admin.post(`/deviations/${internal.id}/close`, {})).json()).toMatchObject({ status: "closed", decision: null });
  });
});

describe("avvikelser: kostnader, kopplade dokument och härledda belopp", () => {
  it("nets manual costs and the issued kreditfaktura / attested leverantörskreditnota — drafts never count", async () => {
    const admin = api(await cookieWith("admin", "Admin"));
    const f = await fixtures(admin);
    const c = (await admin.post("/deviations", { type: "customer", title: "Skadad", customerId: f.customer.id })).json();

    const material = await admin.post(`/deviations/${c.id}/costs`, { kind: "material", amount: 1000, description: "Ny diskbänk" });
    expect(material.statusCode).toBe(201);
    await admin.post(`/deviations/${c.id}/costs`, { kind: "freight", amount: "250.505" });
    const withRecovery = await admin.post(`/deviations/${c.id}/costs`, { kind: "recovery", amount: 200 });
    expect(withRecovery.json().costs).toMatchObject({ totalCosts: 1250.51, totalRecovery: 200, netCost: 1050.51 });
    expect(withRecovery.json().netCost).toBe(1050.51);
    expect((await admin.post(`/deviations/${c.id}/costs`, { kind: "material", amount: 0 })).statusCode).toBe(400);

    // A credit note linked by hand: a draft does not count, an issued one does.
    const [vat] = await db.select().from(vatCodes).where(eq(vatCodes.code, "MP25"));
    const [credit] = await db.insert(invoices).values({ customerId: f.customer.id, type: "credit", status: "draft" }).returning();
    await db.insert(invoiceRows).values({
      invoiceId: credit!.id,
      description: "Kreditering diskbänk",
      quantity: "1",
      unitPrice: "300",
      vatRate: "25",
      vatCodeId: vat!.id,
      lineAmount: "300",
      vatAmount: "75",
      lineAmountSek: "300",
    });
    const linked = await admin.post(`/deviations/${c.id}/links`, { documentType: "credit_invoice", documentId: credit!.id });
    expect(linked.statusCode).toBe(201);
    expect(linked.json().links).toEqual([
      expect.objectContaining({ documentType: "credit_invoice", documentId: credit!.id, documentNumber: null, documentStatus: "draft", deleted: false }),
    ]);
    expect(linked.json().costs.derived).toEqual([]);
    expect(linked.json().netCost).toBe(1050.51);

    await db.update(invoices).set({ status: "issued", invoiceNumber: `KF-${crypto.randomUUID().slice(0, 4)}` }).where(eq(invoices.id, credit!.id));
    const issued = (await admin.get(`/deviations/${c.id}`)).json();
    expect(issued.costs.derived).toEqual([
      expect.objectContaining({ kind: "credit", kindLabel: "Kreditering", amount: 300, documentType: "credit_invoice", label: expect.stringMatching(/^Från kreditfaktura KF-/) }),
    ]);
    expect(issued.netCost).toBe(1350.51);
    expect((await admin.get("/deviations")).json().rows[0].netCost).toBe(1350.51);

    // Koppla dokument refuses the wrong type, another customer and a duplicate.
    expect((await admin.post(`/deviations/${c.id}/links`, { documentType: "credit_invoice", documentId: credit!.id })).json().code).toBe(
      "deviation-link-not-allowed"
    );
    expect((await admin.post(`/deviations/${c.id}/links`, { documentType: "purchase_order", documentId: f.po.id })).json().code).toBe(
      "deviation-link-not-allowed"
    );
    const otherOrder = await admin.post(`/deviations/${c.id}/links`, { documentType: "sales_order", documentId: f.otherOrder.id });
    expect(otherOrder.statusCode).toBe(409);
    expect(otherOrder.json().error).toContain("annan kund");
    expect((await admin.post(`/deviations/${c.id}/links`, { documentType: "sales_order", documentId: f.order.id })).statusCode).toBe(201);

    // Ta bort koppling: the credit note's amount leaves with it.
    const linkId = issued.links[0].id;
    const unlinked = await admin.delete(`/deviations/${c.id}/links/${linkId}`);
    expect(unlinked.statusCode).toBe(200);
    expect(unlinked.json().netCost).toBe(1050.51);
    // Ta bort kostnadsrad.
    const removed = await admin.delete(`/deviations/${c.id}/costs/${material.json().costs.rows[0].id}`);
    expect(removed.json().netCost).toBe(50.51);
    expect((await admin.delete(`/deviations/${c.id}/costs/${crypto.randomUUID()}`)).json().code).toBe("deviation-cost-not-found");

    // A leverantörskreditnota on a supplier case: Ersättning once attested,
    // converted at its own rate; an ordinary (positive) invoice never counts.
    const s = (await admin.post("/deviations", { type: "supplier", title: "Fel kvalitet", supplierId: f.supplier.id })).json();
    const [note] = await db
      .insert(supplierInvoices)
      .values({
        registrationNumber: `LF-T${crypto.randomUUID().slice(0, 6)}`,
        invoiceNumber: "KN-1",
        supplierId: f.supplier.id,
        invoiceDate: todayStockholm(),
        vatCodeId: vat!.id,
        netAmount: "-400",
        vatAmount: "-100",
        grossAmount: "-500",
        status: "draft",
      })
      .returning();
    await admin.post(`/deviations/${s.id}/links`, { documentType: "supplier_invoice", documentId: note!.id });
    expect((await admin.get(`/deviations/${s.id}`)).json().netCost).toBe(0);
    await db.update(supplierInvoices).set({ status: "approved" }).where(eq(supplierInvoices.id, note!.id));
    const recovered = (await admin.get(`/deviations/${s.id}`)).json();
    expect(recovered.costs.derived).toEqual([expect.objectContaining({ kind: "recovery", amount: 400, documentType: "supplier_invoice" })]);
    expect(recovered.netCost).toBe(-400);

    const kinds = (await db.select({ event: deviationEvents.event }).from(deviationEvents).where(eq(deviationEvents.deviationId, c.id))).map(
      (e) => e.event
    );
    expect(kinds.filter((k) => k === "cost_added")).toHaveLength(3);
    expect(kinds).toContain("cost_removed");
    expect(kinds.filter((k) => k === "link_added")).toHaveLength(2);
    expect(kinds).toContain("link_removed");
  });
});

describe("avvikelser: bilder och filer", () => {
  it("takes PDF/JPEG/PNG with the right signature, serves them with nosniff and removes them while the case is open", async () => {
    const admin = api(await cookieWith("admin", "Admin"));
    const c = (await admin.post("/deviations", { type: "internal", title: "Foto", correctiveAction: "Ok" })).json();

    const up = await admin.upload(`/deviations/${c.id}/files`, "skada.png", "image/png", PNG);
    expect(up.statusCode).toBe(201);
    expect(up.json()).toMatchObject({ filename: "skada.png", contentType: "image/png", sizeBytes: PNG.length, sha256: expect.any(String) });
    expect(up.json().data).toBeUndefined();

    const text = await admin.upload(`/deviations/${c.id}/files`, "a.txt", "text/plain", Buffer.from("hej"));
    expect(text.statusCode).toBe(400);
    expect(text.json().code).toBe("invalid-deviation-file-type");
    const fakePdf = await admin.upload(`/deviations/${c.id}/files`, "a.pdf", "application/pdf", Buffer.from("not a pdf"));
    expect(fakePdf.json().code).toBe("invalid-deviation-file-type");

    const list = await admin.get(`/deviations/${c.id}/files`);
    expect(list.json()).toHaveLength(1);
    const download = await admin.get(`/deviations/${c.id}/files/${up.json().id}`);
    expect(download.statusCode).toBe(200);
    expect(download.headers["content-type"]).toBe("image/png");
    expect(download.headers["x-content-type-options"]).toBe("nosniff");
    expect(download.rawPayload.equals(PNG)).toBe(true);

    // Avslutad: the file stays (409), Öppna igen and it can go.
    await admin.post(`/deviations/${c.id}/close`, {});
    expect((await admin.delete(`/deviations/${c.id}/files/${up.json().id}`)).json().code).toBe("deviation-not-editable");
    expect((await admin.upload(`/deviations/${c.id}/files`, "b.png", "image/png", PNG)).json().code).toBe("deviation-not-editable");
    await admin.post(`/deviations/${c.id}/reopen`);
    expect((await admin.delete(`/deviations/${c.id}/files/${up.json().id}`)).statusCode).toBe(204);
    expect((await admin.get(`/deviations/${c.id}/files/${up.json().id}`)).json().code).toBe("deviation-file-not-found");
    const events = (await admin.get(`/deviations/${c.id}`)).json().events.map((e: { event: string }) => e.event);
    expect(events).toContain("file_added");
    expect(events).toContain("file_removed");
  });
});

describe("avvikelser: reklamationsrapporten", () => {
  it("prints the letter per type, the investigation only with details=1 and never a cost", async () => {
    const admin = api(await cookieWith("admin", "Admin"));
    const f = await fixtures(admin);
    const c = (
      await admin.post("/deviations", {
        type: "customer",
        title: "Repad diskbänk",
        customerId: f.customer.id,
        salesOrderRowId: f.orderRow.id,
        quantity: 2,
        reasonId: f.reasons.transport.id,
        counterpartyReference: "REK-77",
        description: "Repor på ovansidan",
        causeAnalysis: "Dålig emballering",
        correctiveAction: "Ny diskbänk skickas",
        decision: undefined,
      })
    ).json();
    await admin.patch(`/deviations/${c.id}`, { decision: "accepted" });
    await admin.post(`/deviations/${c.id}/costs`, { kind: "material", amount: 1234 });

    const plain = await admin.get(`/deviations/${c.id}/pdf`);
    expect(plain.statusCode).toBe(200);
    expect(plain.headers["content-type"]).toBe("application/pdf");
    const text = pdfText(plain.rawPayload);
    for (const part of ["Reklamationsbesked", c.deviationNumber, "Restaurang Exempelkrogen AB", "Er referens: REK-77", `Kundorder: ${f.order.orderNumber}`, "Repad diskbänk", "Transportskada", "Repor på ovansidan"]) {
      expect(text).toContain(part);
    }
    expect(text).not.toContain("Dålig emballering");
    expect(text).not.toContain("1 234");

    const detailed = pdfText((await admin.get(`/deviations/${c.id}/pdf?details=1`)).rawPayload);
    expect(detailed).toContain("Dålig emballering");
    expect(detailed).toContain("Ny diskbänk skickas");
    expect(detailed).toContain("Godkänd");

    const s = (await admin.post("/deviations", { type: "supplier", title: "Fel antal", supplierId: f.supplier.id, purchaseOrderId: f.po.id })).json();
    const supplierPdf = pdfText((await admin.get(`/deviations/${s.id}/pdf`)).rawPayload);
    expect(supplierPdf).toContain("Reklamation");
    expect(supplierPdf).toContain(`Inköpsorder: ${f.po.orderNumber}`);
    const internal = (await admin.post("/deviations", { type: "internal", title: "Maskinstopp" })).json();
    expect(pdfText((await admin.get(`/deviations/${internal.id}/pdf`)).rawPayload)).toContain("Avvikelserapport");

    // Skicka itself (fake SMTP): deviation-mail.test.ts.
    expect((await admin.post(`/deviations/${c.id}/email`, { subject: "Reklamation", message: "Hej" })).statusCode).toBe(400);
  });
});

describe("avvikelser: behörigheter och avisering", () => {
  it("office users read, Kvalitet writes; the shop floor reads nothing; Åtgärd senast becomes an alert for Kvalitet", async () => {
    const admin = api(await cookieWith("admin", "Admin"));
    const sales = api(await cookieWith(["forsaljning"], "Saljare"));
    const quality = api(await cookieWith(["kvalitet"], "Kvalitet"));
    const workshop = api(await cookieWith(["terminal"], "Verkstad"));
    await fixtures(admin);

    const created = await quality.post("/deviations", { type: "internal", title: "Sned svets", dueDate: "2020-01-01" });
    expect(created.statusCode).toBe(201);
    const id = created.json().id;
    expect((await sales.get("/deviations")).statusCode).toBe(200);
    expect((await sales.get(`/deviations/${id}`)).json().netCost).toBe(0);
    expect((await sales.post("/deviations", { type: "internal", title: "Nej" })).statusCode).toBe(403);
    expect((await sales.patch(`/deviations/${id}`, { title: "Nej" })).statusCode).toBe(403);
    expect((await sales.post(`/deviations/${id}/start`)).statusCode).toBe(403);
    expect((await workshop.get("/deviations")).statusCode).toBe(403);
    expect((await quality.post(`/deviations/${id}/start`)).statusCode).toBe(200);

    const alerts = (await quality.get("/alerts")).json();
    const group = alerts.groups.find((g: { kind: string }) => g.kind === "deviations_overdue");
    expect(group).toMatchObject({ count: 1, severity: "yellow", listHref: "/kvalitet/avvikelser?overdue=1" });
    expect(group.items[0]).toMatchObject({ key: id, href: `/kvalitet/avvikelser/${id}`, primary: expect.stringContaining("Sned svets"), date: "2020-01-01" });
    expect((await sales.get("/alerts")).json().groups.some((g: { kind: string }) => g.kind === "deviations_overdue")).toBe(false);
    // Closed: no longer overdue.
    await quality.patch(`/deviations/${id}`, { correctiveAction: "Omsvetsad" });
    await quality.post(`/deviations/${id}/close`, {});
    expect((await quality.get("/alerts")).json().groups.find((g: { kind: string }) => g.kind === "deviations_overdue").count).toBe(0);
  });
});

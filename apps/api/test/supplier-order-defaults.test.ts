import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { eq, sql } from "drizzle-orm";
import { db, emailLog, inquiries, purchaseOrders } from "@navet/db";
import {
  createArticleSchema,
  createArticleSupplierSchema,
  createContactSchema,
  createSupplierSchema,
  createWorkCenterSchema,
  emailCcSchema,
  MAX_EMAIL_CC,
  sendPurchaseOrderEmailSchema,
  sendSupplierDocumentEmailSchema,
} from "@navet/shared";
import { buildApp } from "../src/app.js";
import { createArticleRepository } from "../src/modules/article/repository/article.repository.js";
import { createArticleService } from "../src/modules/article/service/article.service.js";
import { createAuthRepository } from "../src/modules/auth/repository/auth.repository.js";
import { createAuthService } from "../src/modules/auth/service/auth.service.js";
import { createMailRepository } from "../src/modules/mail/repository/mail.repository.js";
import { createMailService, normalizeCc, type MailTransportFactory } from "../src/modules/mail/service/mail.service.js";
import { createManufacturingRepository } from "../src/modules/manufacturing/repository/manufacturing.repository.js";
import { createManufacturingService } from "../src/modules/manufacturing/service/manufacturing.service.js";
import { createPurchaseRepository } from "../src/modules/purchase/repository/purchase.repository.js";
import { resolveOrderDefaults } from "../src/modules/purchase/repository/supplier-order-defaults.js";
import { createPurchaseService } from "../src/modules/purchase/service/purchase.service.js";
import { createRegisterRepository } from "../src/modules/register/repository/register.repository.js";
import { createRegisterService } from "../src/modules/register/service/register.service.js";
import { createSalesRepository } from "../src/modules/sales/repository/sales.repository.js";
import { markSalesOrderInProduction } from "../src/modules/sales/service/production-transition.js";
import { createAuditRepository } from "../src/modules/system/repository/audit.repository.js";
import { parsed } from "./helpers/parsed.js";
import { testArticleService, testDocumentPdfService, testSystemService } from "./helpers/services.js";

// Inköp: leverantörens förval (migration 0217), through the real app with a
// fake mail transport:
//  1. Frakt på vårt konto (förval) fills freight_paid_by_us on a new inquiry
//     and purchase order in every creation path — an explicit value wins.
//  2. E-post för inköpsorder is the recipient of a sent purchase order, Kopia
//     (cc) goes out as Cc, is logged, and Skicka om sends the same copy.
//  3. Er referens on a new order = the supplier's huvudkontakt.
// The fixtures are created through the services on the same database; the
// feature itself is exercised over HTTP. All data made up.

interface SentMail {
  to: string;
  cc?: string[];
  subject: string;
}
const sent: SentMail[] = [];
let failNext = false;
const fakeTransport: MailTransportFactory = () => ({
  async sendMail(opts) {
    if (failNext) {
      failNext = false;
      throw new Error("Connection refused");
    }
    sent.push({ to: opts.to, cc: opts.cc, subject: opts.subject });
  },
});

const auditRepository = createAuditRepository(db);
const authService = createAuthService(createAuthRepository(db), "unused", auditRepository);
const articleService = createArticleService(createArticleRepository(db));
const salesRepository = createSalesRepository(db);
const mfgService = createManufacturingService(createManufacturingRepository(db), testDocumentPdfService, testArticleService, {
  findRowForManufacturing: salesRepository.findRowForManufacturing,
  lockRowForManufacturing: salesRepository.lockRowForManufacturing,
  markInProduction: markSalesOrderInProduction,
});
// Fixtures only (suppliers, contacts, the catalog) — never the code under test.
const fixtures = createPurchaseService(
  createPurchaseRepository(db),
  createRegisterService(createRegisterRepository(db)),
  createMailService(createMailRepository(db), testSystemService, fakeTransport),
  testDocumentPdfService,
  testArticleService,
  testSystemService,
  mfgService
);

const PASSWORD = "correcthorsebattery";
const TABLES = sql`TRUNCATE audit_log, email_log, inquiry_rows, inquiries, purchase_receipts, purchase_order_rows, purchase_orders,
  article_suppliers, supplier_contacts, suppliers, mo_material_consumptions, mo_operation_scrap, mo_operations, manufacturing_orders,
  routing_operations, work_centers, production_groups, stock_transactions, bom_components, articles, user_settings, users CASCADE`;

let app: ReturnType<typeof buildApp>;
let cookie: string;
let userId: string;

beforeAll(async () => {
  app = buildApp(db, { mailTransport: fakeTransport });
  await app.ready();
});
beforeEach(async () => {
  await db.execute(TABLES);
  await testSystemService.updateSettings({ smtpHost: "smtp.test.local", smtpFromEmail: "erp@test.local" });
  sent.length = 0;
  failNext = false;
  const email = `forval-${crypto.randomUUID()}@example.com`;
  const user = await authService.createUser({ email, password: PASSWORD, name: "Inköparen", role: "admin" });
  userId = user.id;
  const res = await app.inject({ method: "POST", url: "/api/v1/auth/login", payload: { email, password: PASSWORD } });
  expect(res.statusCode).toBe(200);
  cookie = `session=${res.cookies.find((c) => c.name === "session")!.value}`;
});
afterAll(async () => {
  await app.close();
  await db.execute(TABLES);
});

function call(method: "GET" | "POST" | "PATCH", url: string, payload?: unknown) {
  return app.inject({ method, url: `/api/v1${url}`, headers: { cookie }, ...(payload !== undefined ? { payload: payload as object } : {}) });
}

// A supplier with the förval set (or not) and a huvudkontakt (or not).
async function supplier(opts: { freight?: boolean; orderEmail?: string; email?: string; contact?: { name: string; email?: string } | null } = {}) {
  const created = await fixtures.createSupplier(
    parsed(createSupplierSchema, {
      name: `Leverantör ${crypto.randomUUID().slice(0, 6)}`,
      active: true,
      freightPaidByUsDefault: opts.freight ?? false,
      ...(opts.orderEmail ? { purchaseOrderEmail: opts.orderEmail } : {}),
      ...(opts.email ? { email: opts.email } : {}),
    })
  );
  if (opts.contact) {
    await fixtures.createSupplierContact(created.id, parsed(createContactSchema, { ...opts.contact, isPrimary: true }));
  }
  return created;
}

async function article(type: "purchased" | "manufactured" = "purchased") {
  const number = `FV-${crypto.randomUUID().slice(0, 8)}`;
  return articleService.createArticle(parsed(createArticleSchema, { articleNumber: number, name: number, type, active: true }));
}

async function orderRow(id: string) {
  const [row] = await db.select().from(purchaseOrders).where(eq(purchaseOrders.id, id));
  return row!;
}

async function newOrder(supplierId: string, extra: Record<string, unknown> = {}) {
  const res = await call("POST", "/purchase-orders", { supplierId, ...extra });
  expect(res.statusCode).toBe(201);
  return res.json() as { id: string; orderNumber: string; freightPaidByUs: boolean; yourReference: string | null };
}

describe("the supplier card's fields", () => {
  it("stores Frakt på vårt konto and E-post för inköpsorder, and a PATCH of one leaves the other", async () => {
    const created = await call("POST", "/suppliers", { name: "Stål AB", freightPaidByUsDefault: true, purchaseOrderEmail: "order@example.com" });
    expect(created.statusCode).toBe(201);
    const id = created.json().id as string;
    expect(created.json()).toMatchObject({ freightPaidByUsDefault: true, purchaseOrderEmail: "order@example.com" });

    const patched = await call("PATCH", `/suppliers/${id}`, { freightPaidByUsDefault: false });
    expect(patched.statusCode).toBe(200);
    expect(patched.json()).toMatchObject({ freightPaidByUsDefault: false, purchaseOrderEmail: "order@example.com" });

    const cleared = await call("PATCH", `/suppliers/${id}`, { purchaseOrderEmail: null });
    expect(cleared.json()).toMatchObject({ freightPaidByUsDefault: false, purchaseOrderEmail: null });

    // The förval is off unless set, and the address is validated like E-post.
    const plain = await call("POST", "/suppliers", { name: "Plåt AB" });
    expect(plain.json()).toMatchObject({ freightPaidByUsDefault: false, purchaseOrderEmail: null });
    const bad = await call("PATCH", `/suppliers/${id}`, { purchaseOrderEmail: "inte en adress" });
    expect(bad.statusCode).toBe(400);
    expect(bad.json().code).toBe("validation-failed");
  });
});

describe("förvalen på en ny inköpsorder (Ny inköpsorder)", () => {
  it("takes Frakt på vårt konto and the huvudkontakt as Er referens from the supplier", async () => {
    const s = await supplier({ freight: true, contact: { name: "Sara Säljare", email: "sara@example.com" } });
    const order = await newOrder(s.id);
    expect(order).toMatchObject({ freightPaidByUs: true, yourReference: "Sara Säljare" });
  });

  it("without förval: no freight on our account and no reference", async () => {
    const s = await supplier();
    const order = await newOrder(s.id);
    expect(order).toMatchObject({ freightPaidByUs: false, yourReference: null });
  });

  it("only the huvudkontakt counts — another contact is not Er referens", async () => {
    const s = await supplier();
    await fixtures.createSupplierContact(s.id, parsed(createContactSchema, { name: "Olle Övrig" }));
    expect((await newOrder(s.id)).yourReference).toBeNull();
  });

  it("an explicit value wins, both ways — also an explicitly empty Er referens", async () => {
    const withDefaults = await supplier({ freight: true, contact: { name: "Sara Säljare" } });
    expect(await newOrder(withDefaults.id, { freightPaidByUs: false, yourReference: "Bo Beställare" })).toMatchObject({
      freightPaidByUs: false,
      yourReference: "Bo Beställare",
    });
    expect((await newOrder(withDefaults.id, { yourReference: "" })).yourReference).toBeNull();

    const without = await supplier();
    expect((await newOrder(without.id, { freightPaidByUs: true })).freightPaidByUs).toBe(true);
  });

  it("a later change on the supplier card leaves the order as it was created", async () => {
    const s = await supplier({ freight: true, contact: { name: "Sara Säljare" } });
    const order = await newOrder(s.id);
    await call("PATCH", `/suppliers/${s.id}`, { freightPaidByUsDefault: false });
    expect(await orderRow(order.id)).toMatchObject({ freightPaidByUs: true, yourReference: "Sara Säljare" });
  });

  it("a contact name longer than the column is cut to 100 characters", () => {
    const long = "N".repeat(140);
    const resolved = resolveOrderDefaults({ freightPaidByUs: false, yourReference: long, purchaseOrderRecipient: null }, {});
    expect(resolved.yourReference).toBe("N".repeat(100));
  });
});

describe("förvalen på en förfrågan och på ordern den blir", () => {
  async function newInquiry(supplierId: string, extra: Record<string, unknown> = {}) {
    const a = await article();
    const res = await call("POST", "/inquiries", { supplierId, rows: [{ articleId: a.id, quantity: 5, unitPrice: 20 }], ...extra });
    expect(res.statusCode).toBe(201);
    return res.json().inquiry as { id: string; freightPaidByUs: boolean };
  }

  it("a new inquiry takes Frakt på vårt konto from the supplier; an explicit value wins", async () => {
    const withDefault = await supplier({ freight: true });
    expect((await newInquiry(withDefault.id)).freightPaidByUs).toBe(true);
    expect((await newInquiry(withDefault.id, { freightPaidByUs: false })).freightPaidByUs).toBe(false);

    const without = await supplier();
    expect((await newInquiry(without.id)).freightPaidByUs).toBe(false);
    expect((await newInquiry(without.id, { freightPaidByUs: true })).freightPaidByUs).toBe(true);
  });

  it("Skapa inköpsorder: the inquiry's own freight choice wins over the förval, Er referens is the huvudkontakt", async () => {
    const s = await supplier({ freight: true, contact: { name: "Sara Säljare" } });
    // Switched off on the inquiry — the order follows the inquiry, not the card.
    const inquiry = await newInquiry(s.id);
    expect((await call("PATCH", `/inquiries/${inquiry.id}`, { freightPaidByUs: false })).statusCode).toBe(200);
    expect((await call("POST", `/inquiries/${inquiry.id}/send`)).statusCode).toBe(200);
    const converted = await call("POST", `/inquiries/${inquiry.id}/convert-to-order`);
    expect(converted.statusCode).toBe(201);
    expect(await orderRow(converted.json().id)).toMatchObject({ freightPaidByUs: false, yourReference: "Sara Säljare" });

    // And the other way: on for the inquiry, off on the card.
    const off = await supplier();
    const other = await newInquiry(off.id, { freightPaidByUs: true });
    await call("POST", `/inquiries/${other.id}/send`);
    const second = await call("POST", `/inquiries/${other.id}/convert-to-order`);
    expect(await orderRow(second.json().id)).toMatchObject({ freightPaidByUs: true, yourReference: null });
    const [stored] = await db.select().from(inquiries).where(eq(inquiries.id, other.id));
    expect(stored!.status).toBe("ordered");
  });
});

describe("förvalen genom Skapa ordrar (behovsberäkningen, Behöver beställas, legoinköpet från TO-kortet)", () => {
  it("a purchase proposal's order gets the supplier's förval — and none without", async () => {
    const withDefaults = await supplier({ freight: true, contact: { name: "Sara Säljare" } });
    const without = await supplier();
    const a = await article();
    const b = await article();
    await fixtures.addArticleSupplier(a.id, parsed(createArticleSupplierSchema, { supplierId: withDefaults.id, price: 5, isPrimary: true }));
    await fixtures.addArticleSupplier(b.id, parsed(createArticleSupplierSchema, { supplierId: without.id, price: 5, isPrimary: true }));

    const res = await call("POST", "/planning/orders", {
      proposals: [
        { articleId: a.id, quantity: 10, kind: "purchase" },
        { articleId: b.id, quantity: 10, kind: "purchase" },
      ],
    });
    expect(res.statusCode).toBe(201);
    const result = res.json() as { purchaseOrders: { id: string; supplierId: string }[]; errors: unknown[] };
    expect(result.errors).toEqual([]);
    expect(result.purchaseOrders).toHaveLength(2);
    const byDefault = result.purchaseOrders.find((o) => o.supplierId === withDefaults.id)!;
    const plain = result.purchaseOrders.find((o) => o.supplierId === without.id)!;
    expect(await orderRow(byDefault.id)).toMatchObject({ freightPaidByUs: true, yourReference: "Sara Säljare" });
    expect(await orderRow(plain.id)).toMatchObject({ freightPaidByUs: false, yourReference: null });
  });

  it("a lego proposal's order (TO-kortet) gets the legoleverantör's förval", async () => {
    const legoSupplier = await supplier({ freight: true, contact: { name: "Lena Lego" } });
    const machine = await mfgService.createWorkCenter(parsed(createWorkCenterSchema, { code: "100", name: "Svets", type: "machine", active: true }));
    const lego = await mfgService.createWorkCenter(
      parsed(createWorkCenterSchema, { code: "900", name: "Ytbehandling", type: "subcontract", supplierId: legoSupplier.id, active: true })
    );
    const parent = await article("manufactured");
    await mfgService.createRoutingOperation(parent.id, { sequenceNo: 10, workCenterId: machine.id, setupTime: 0, runTimePerUnit: 1 });
    await mfgService.createRoutingOperation(parent.id, { sequenceNo: 20, workCenterId: lego.id, setupTime: 0, runTimePerUnit: 0, setupPrice: 500, unitPrice: 100 });
    const mo = await mfgService.createManufacturingOrder({ articleId: parent.id, quantity: 4 }, userId);
    const legoOp = (await mfgService.listOperations(mo.id)).find((op) => op.sequenceNo === 20)!;

    const res = await call("POST", "/planning/orders", {
      proposals: [{ articleId: parent.id, quantity: 4, kind: "subcontract", moOperationId: legoOp.id }],
    });
    expect(res.statusCode).toBe(201);
    const result = res.json() as { purchaseOrders: { id: string }[]; errors: unknown[] };
    expect(result.errors).toEqual([]);
    expect(result.purchaseOrders).toHaveLength(1);
    expect(await orderRow(result.purchaseOrders[0]!.id)).toMatchObject({
      supplierId: legoSupplier.id,
      freightPaidByUs: true,
      yourReference: "Lena Lego",
    });
  });
});

describe("mottagaren när en inköpsorder skickas", () => {
  const mail = { subject: "Inköpsorder", message: "Hej" };

  it("E-post för inköpsorder wins over the huvudkontakt and the supplier's E-post", async () => {
    const s = await supplier({ orderEmail: "order@example.com", email: "info@example.com", contact: { name: "Sara", email: "sara@example.com" } });
    const order = await newOrder(s.id);
    expect((await call("GET", `/purchase-orders/${order.id}`)).json().defaultRecipient).toBe("order@example.com");

    const res = await call("POST", `/purchase-orders/${order.id}/send-email`, mail);
    expect(res.statusCode).toBe(200);
    expect(res.json().status).toBe("confirmed");
    expect(sent).toEqual([{ to: "order@example.com", cc: undefined, subject: "Inköpsorder" }]);
  });

  it("without the field: the huvudkontakt's address, then the supplier's E-post, as before", async () => {
    const viaContact = await supplier({ email: "info@example.com", contact: { name: "Sara", email: "sara@example.com" } });
    const first = await newOrder(viaContact.id);
    expect((await call("GET", `/purchase-orders/${first.id}`)).json().defaultRecipient).toBe("sara@example.com");
    await call("POST", `/purchase-orders/${first.id}/send-email`, mail);

    const viaSupplier = await supplier({ email: "info@example.com", contact: { name: "Utan adress" } });
    const second = await newOrder(viaSupplier.id);
    await call("POST", `/purchase-orders/${second.id}/send-email`, mail);

    expect(sent.map((m) => m.to)).toEqual(["sara@example.com", "info@example.com"]);
  });

  it("a typed Mottagare wins over the supplier's addresses", async () => {
    const s = await supplier({ orderEmail: "order@example.com" });
    const order = await newOrder(s.id);
    await call("POST", `/purchase-orders/${order.id}/send-email`, { ...mail, to: "annan@example.com" });
    expect(sent.map((m) => m.to)).toEqual(["annan@example.com"]);
  });

  it("no address anywhere and none typed: 400 purchase-order-recipient-missing, nothing sent, still a draft", async () => {
    const s = await supplier();
    const order = await newOrder(s.id);
    expect((await call("GET", `/purchase-orders/${order.id}`)).json().defaultRecipient).toBeNull();
    const res = await call("POST", `/purchase-orders/${order.id}/send-email`, mail);
    expect(res.statusCode).toBe(400);
    expect(res.json().code).toBe("purchase-order-recipient-missing");
    expect(sent).toEqual([]);
    expect(await db.select().from(emailLog)).toHaveLength(0);
    expect((await orderRow(order.id)).status).toBe("draft");
  });
});

describe("Kopia", () => {
  const mail = { subject: "Inköpsorder", message: "Hej" };

  it("goes out as Cc and is logged — without duplicates and without the recipient itself", async () => {
    const s = await supplier({ orderEmail: "order@example.com" });
    const order = await newOrder(s.id);
    const res = await call("POST", `/purchase-orders/${order.id}/send-email`, {
      ...mail,
      cc: ["sara@example.com", " Sara@Example.com ", "order@example.com", "chef@example.com"],
    });
    expect(res.statusCode).toBe(200);
    expect(sent).toEqual([{ to: "order@example.com", cc: ["sara@example.com", "chef@example.com"], subject: "Inköpsorder" }]);

    const log = (await call("GET", `/email-log?documentId=${order.id}`)).json().rows as { recipient: string; cc: string[]; status: string }[];
    expect(log).toHaveLength(1);
    expect(log[0]).toMatchObject({ recipient: "order@example.com", cc: ["sara@example.com", "chef@example.com"], status: "sent" });

    // The log is searchable on the copy, and the export has its own column.
    expect((await call("GET", "/email-log?search=chef@example")).json().total).toBe(1);
    expect((await call("GET", "/email-log?search=ingen@example")).json().total).toBe(0);
    const csv = await call("GET", "/email-log/csv");
    expect(csv.body).toContain("Kopia");
    expect(csv.body).toContain("sara@example.com, chef@example.com");
  });

  it("no Kopia: no Cc header and an empty list in the log", async () => {
    const s = await supplier({ orderEmail: "order@example.com" });
    const order = await newOrder(s.id);
    await call("POST", `/purchase-orders/${order.id}/send-email`, mail);
    expect(sent[0]!.cc).toBeUndefined();
    const [row] = await db.select().from(emailLog);
    expect(row!.cc).toEqual([]);
  });

  it("Skicka om sends the same copy to the same recipient", async () => {
    const s = await supplier({ orderEmail: "order@example.com" });
    const order = await newOrder(s.id);
    failNext = true;
    const failed = await call("POST", `/purchase-orders/${order.id}/send-email`, { ...mail, cc: ["sara@example.com"] });
    expect(failed.statusCode).toBe(502);
    expect(sent).toEqual([]);
    // A failed send keeps the order a draft and logs the copy.
    expect((await orderRow(order.id)).status).toBe("draft");
    const [entry] = await db.select().from(emailLog);
    expect(entry).toMatchObject({ status: "failed", recipient: "order@example.com", cc: ["sara@example.com"] });

    // The supplier's address changes meanwhile — the resend goes where the
    // failed one was going, with its copy.
    await call("PATCH", `/suppliers/${s.id}`, { purchaseOrderEmail: "ny@example.com" });
    const resent = await call("POST", `/email-log/${entry!.id}/resend`);
    expect(resent.statusCode).toBe(200);
    expect(sent).toEqual([{ to: "order@example.com", cc: ["sara@example.com"], subject: "Inköpsorder" }]);
    expect((await orderRow(order.id)).status).toBe("confirmed");
    const rows = await db.select().from(emailLog);
    expect(rows.map((r) => [r.status, r.cc])).toEqual(
      expect.arrayContaining([
        ["failed", ["sara@example.com"]],
        ["sent", ["sara@example.com"]],
      ])
    );
  });

  it("the inquiry's send takes Kopia too, and Skicka om replays it", async () => {
    const s = await supplier({ email: "info@example.com" });
    const a = await article();
    const created = await call("POST", "/inquiries", { supplierId: s.id, rows: [{ articleId: a.id, quantity: 1 }] });
    const inquiryId = created.json().inquiry.id as string;
    failNext = true;
    const failed = await call("POST", `/inquiries/${inquiryId}/send-email`, {
      to: "info@example.com",
      subject: "Förfrågan",
      message: "",
      cc: ["sara@example.com"],
    });
    expect(failed.statusCode).toBe(502);
    const [entry] = await db.select().from(emailLog);
    const resent = await call("POST", `/email-log/${entry!.id}/resend`);
    expect(resent.statusCode).toBe(200);
    expect(sent).toEqual([{ to: "info@example.com", cc: ["sara@example.com"], subject: "Förfrågan" }]);
    // Mottagare stays required on the inquiry.
    const noRecipient = await call("POST", `/inquiries/${inquiryId}/send-email`, { subject: "Förfrågan", message: "" });
    expect(noRecipient.statusCode).toBe(400);
  });

  it("validates the copy's addresses: a malformed one and more than the limit are 400, nothing sent", async () => {
    const s = await supplier({ orderEmail: "order@example.com" });
    const order = await newOrder(s.id);
    const malformed = await call("POST", `/purchase-orders/${order.id}/send-email`, { ...mail, cc: ["sara@example.com", "inte en adress"] });
    expect(malformed.statusCode).toBe(400);
    expect(malformed.json().code).toBe("validation-failed");
    const tooMany = await call("POST", `/purchase-orders/${order.id}/send-email`, {
      ...mail,
      cc: Array.from({ length: MAX_EMAIL_CC + 1 }, (_, i) => `kopia${i}@example.com`),
    });
    expect(tooMany.statusCode).toBe(400);
    const notAList = await call("POST", `/purchase-orders/${order.id}/send-email`, { ...mail, cc: "sara@example.com" });
    expect(notAList.statusCode).toBe(400);
    expect(sent).toEqual([]);
    expect((await orderRow(order.id)).status).toBe("draft");
  });

  it("the schemas and the normalisation", () => {
    expect(emailCcSchema.parse(undefined)).toEqual([]);
    expect(emailCcSchema.parse([" a@example.com "])).toEqual(["a@example.com"]);
    expect(emailCcSchema.safeParse(Array.from({ length: MAX_EMAIL_CC }, (_, i) => `k${i}@example.com`)).success).toBe(true);
    expect(sendSupplierDocumentEmailSchema.safeParse({ subject: "x" }).success).toBe(false);
    expect(sendPurchaseOrderEmailSchema.parse({ subject: "x" })).toMatchObject({ cc: [], attachDrawings: false });
    expect(normalizeCc(["B@x.se", "b@x.se", "a@x.se", " "], "A@x.se")).toEqual(["B@x.se"]);
    expect(normalizeCc(undefined, "a@x.se")).toEqual([]);
  });
});

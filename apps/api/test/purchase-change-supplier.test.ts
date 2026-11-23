import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { asc, eq, inArray, sql } from "drizzle-orm";
import {
  auditLog,
  db,
  exchangeRates,
  inquiries,
  moOperations,
  permissionGroups,
  purchaseOrderRows,
  purchaseOrders,
  purchaseReceipts,
  type Tx,
} from "@navet/db";
import {
  createArticleSchema,
  createArticleSupplierSchema,
  createContactSchema,
  createInquirySchema,
  createPurchaseOrderSchema,
  createSupplierSchema,
  createWorkCenterSchema,
  type SupplierChangePreview,
} from "@navet/shared";
import { buildApp } from "../src/app.js";
import { createArticleRepository } from "../src/modules/article/repository/article.repository.js";
import { createArticleService } from "../src/modules/article/service/article.service.js";
import { createAuthRepository } from "../src/modules/auth/repository/auth.repository.js";
import { createAuthService } from "../src/modules/auth/service/auth.service.js";
import { createMailRepository } from "../src/modules/mail/repository/mail.repository.js";
import { createMailService } from "../src/modules/mail/service/mail.service.js";
import { createManufacturingRepository } from "../src/modules/manufacturing/repository/manufacturing.repository.js";
import { createManufacturingService } from "../src/modules/manufacturing/service/manufacturing.service.js";
import { createPurchaseRepository } from "../src/modules/purchase/repository/purchase.repository.js";
import { createPurchaseService } from "../src/modules/purchase/service/purchase.service.js";
import { createRegisterRepository } from "../src/modules/register/repository/register.repository.js";
import { createRegisterService } from "../src/modules/register/service/register.service.js";
import { createSalesRepository } from "../src/modules/sales/repository/sales.repository.js";
import { markSalesOrderInProduction } from "../src/modules/sales/service/production-transition.js";
import { createAuditRepository } from "../src/modules/system/repository/audit.repository.js";
import { stockholmToday } from "../src/modules/system/service/delivery-days.js";
import { parsed } from "./helpers/parsed.js";
import { testArticleService, testDocumentPdfService, testSystemService } from "./helpers/services.js";
import { waitForLockWaiter } from "./helpers/year-end.js";

// Byt leverantör på inköps- och legoinköpsorder: POST
// /purchase-orders/:id/change-supplier[/preview] through the real app — the
// statuses, every blocker, the prices (catalog with staffel, converted,
// unchanged), the currency and rate, what the order takes from the new
// supplier, the stale preview, the permissions and the locks. The fixtures
// are created through the services on the same database. All data made up.

const auditRepository = createAuditRepository(db);
const authService = createAuthService(createAuthRepository(db), "unused", auditRepository);
const articleService = createArticleService(createArticleRepository(db));
const registerService = createRegisterService(createRegisterRepository(db));
const salesRepository = createSalesRepository(db);
const mfgService = createManufacturingService(createManufacturingRepository(db), testDocumentPdfService, testArticleService, {
  findRowForManufacturing: salesRepository.findRowForManufacturing,
  lockRowForManufacturing: salesRepository.lockRowForManufacturing,
  markInProduction: markSalesOrderInProduction,
});
// Fixtures only — the code under test runs behind the app's own service.
const fixtures = createPurchaseService(
  createPurchaseRepository(db),
  registerService,
  createMailService(createMailRepository(db), testSystemService),
  testDocumentPdfService,
  testArticleService,
  testSystemService,
  mfgService
);

const PASSWORD = "correcthorsebattery";
const TODAY = stockholmToday();
const TABLES = sql`TRUNCATE audit_log, exchange_rates, deviation_links, deviations, supplier_invoice_rows, supplier_invoices, inquiry_rows, inquiries,
  purchase_order_dispatch_rows, purchase_order_dispatches, purchase_receipts, mo_report_materials, mo_reports, purchase_order_rows,
  purchase_orders, article_suppliers, supplier_contacts, suppliers, delivery_terms, mo_material_consumptions, mo_operation_scrap,
  mo_operations, manufacturing_orders, routing_operations, work_centers, production_groups, stock_transactions, bom_components,
  articles, user_settings, users CASCADE`;

let app: ReturnType<typeof buildApp>;
let cookie: string;
let userId: string;
const groupIds: string[] = [];

beforeAll(async () => {
  app = buildApp(db);
  await app.ready();
});
beforeEach(async () => {
  await db.execute(TABLES);
  const email = `byt-${crypto.randomUUID()}@example.com`;
  const user = await authService.createUser({ email, password: PASSWORD, name: "Inköparen", role: "admin" });
  userId = user.id;
  cookie = await login(email);
});
afterAll(async () => {
  await app.close();
  await db.execute(TABLES);
  if (groupIds.length > 0) await db.delete(permissionGroups).where(inArray(permissionGroups.id, groupIds));
});

async function login(email: string) {
  const res = await app.inject({ method: "POST", url: "/api/v1/auth/login", payload: { email, password: PASSWORD } });
  expect(res.statusCode).toBe(200);
  return `session=${res.cookies.find((c) => c.name === "session")!.value}`;
}

async function userCookie(permissions: string[], readOnly = false) {
  const [group] = await db
    .insert(permissionGroups)
    .values({ code: `BYT${crypto.randomUUID().slice(0, 6)}`, name: "Byt leverantör", permissions })
    .returning();
  groupIds.push(group!.id);
  const email = `byt-user-${crypto.randomUUID()}@example.com`;
  await authService.createUser({ email, password: PASSWORD, name: "Användare", role: "user", permissionGroupId: group!.id, readOnly });
  return login(email);
}

function call(method: "GET" | "POST" | "PATCH", url: string, payload?: unknown, as: string = cookie) {
  return app.inject({
    method,
    url: `/api/v1${url}`,
    headers: { cookie: as, origin: "http://localhost" },
    ...(payload !== undefined ? { payload: payload as object } : {}),
  });
}

async function supplier(name: string, extra: Record<string, unknown> = {}) {
  return fixtures.createSupplier(parsed(createSupplierSchema, { name, active: true, ...extra }));
}

async function article(number: string, type: "purchased" | "manufactured" = "purchased") {
  return articleService.createArticle(parsed(createArticleSchema, { articleNumber: number, name: `Benämning ${number}`, type, active: true }));
}

async function catalog(articleId: string, supplierId: string, extra: Record<string, unknown>) {
  await fixtures.addArticleSupplier(articleId, parsed(createArticleSupplierSchema, { supplierId, ...extra }));
}

async function eurRate(rate: number) {
  await db.insert(exchangeRates).values({ currency: "EUR", date: TODAY, rate: String(rate), source: "manual" });
}

// An order at `supplierId` with one row per entry, in Utkast unless confirmed.
async function order(supplierId: string, rows: { articleId: string; quantity: number; unitPrice: number }[], opts: { confirm?: boolean; exchangeRate?: number } = {}) {
  const created = await fixtures.createPurchaseOrder(
    parsed(createPurchaseOrderSchema, { supplierId, ourReference: "Vår Inköpare", note: "Lossas på baksidan", exchangeRate: opts.exchangeRate }),
    userId
  );
  const made = [];
  for (const row of rows) made.push(await fixtures.addRow(created.id, row));
  if (opts.confirm) await fixtures.confirm(created.id);
  return { order: created, rows: made };
}

async function stored(orderId: string) {
  const [o] = await db.select().from(purchaseOrders).where(eq(purchaseOrders.id, orderId));
  const rows = await db
    .select()
    .from(purchaseOrderRows)
    .where(eq(purchaseOrderRows.purchaseOrderId, orderId))
    .orderBy(asc(purchaseOrderRows.createdAt), asc(purchaseOrderRows.id));
  return { order: o!, rows };
}

async function preview(orderId: string, supplierId: string, extra: Record<string, unknown> = {}) {
  return call("POST", `/purchase-orders/${orderId}/change-supplier/preview`, { supplierId, ...extra });
}

function expectedOf(p: SupplierChangePreview) {
  return {
    supplierId: p.from.supplierId,
    currency: p.to.currency,
    exchangeRate: p.to.exchangeRate,
    rows: p.rows.map((r) => ({ rowId: r.rowId, unitPrice: r.after.unitPrice, setupPrice: r.after.setupPrice })),
  };
}

// Preview, then change with exactly what the preview showed.
async function change(orderId: string, supplierId: string, extra: Record<string, unknown> = {}, as: string = cookie) {
  const p = await preview(orderId, supplierId, extra);
  expect(p.statusCode).toBe(200);
  return call("POST", `/purchase-orders/${orderId}/change-supplier`, { supplierId, ...extra, expected: expectedOf(p.json()) }, as);
}

// Runs `action` while another transaction holds the locks `lock` took and
// lets it commit once `waiters` transactions wait on them.
async function whileHolding<T>(lock: (tx: Tx) => Promise<unknown>, action: () => Promise<T>, waiters = 1) {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => (release = resolve));
  let locked!: () => void;
  const hasLocks = new Promise<void>((resolve) => (locked = resolve));
  const holder = db.transaction(async (tx) => {
    await lock(tx);
    locked();
    await gate;
  });
  await Promise.race([hasLocks, holder]);
  const acting = action();
  try {
    await waitForLockWaiter(10_000, waiters);
  } finally {
    release();
  }
  await holder;
  return acting;
}

// Legoartikel: operation 20 on a legoresurs of `legoSupplierId`; a released
// TO and an IO at that supplier with one lego row (4 st à 100, ställpris 500).
async function legoOrder(legoSupplierId: string) {
  const lego = await mfgService.createWorkCenter(
    parsed(createWorkCenterSchema, { code: "900", name: "Ytbehandling", type: "subcontract", supplierId: legoSupplierId, active: true })
  );
  const parent = await article(`LEGO-${crypto.randomUUID().slice(0, 6)}`, "manufactured");
  await mfgService.createRoutingOperation(parent.id, {
    sequenceNo: 20,
    workCenterId: lego.id,
    setupTime: 0,
    runTimePerUnit: 0,
    setupPrice: 500,
    unitPrice: 100,
  });
  const mo = await mfgService.createManufacturingOrder({ articleId: parent.id, quantity: 4 }, userId);
  const [legoOp] = await mfgService.listOperations(mo.id);
  const io = await fixtures.createPurchaseOrder(parsed(createPurchaseOrderSchema, { supplierId: legoSupplierId }), userId);
  const row = await fixtures.addRow(io.id, { articleId: parent.id, quantity: 4, unitPrice: 100, moOperationId: legoOp!.id, setupPrice: 500 });
  return { parent, io, row, legoOp: legoOp! };
}

describe("status and what the order takes from the new supplier", () => {
  it("changes the supplier of a draft: terms, Er referens and frakt from the new supplier, the rest untouched, revision bumped once, audit row", async () => {
    const term = await registerService.deliveryTerms.create({ code: "FCA", name: "Fritt fraktföraren" });
    const old = await supplier("Gamla Stål AB");
    const next = await supplier("Nya Stål AB", { deliveryTermId: term.id, freightPaidByUsDefault: true });
    await fixtures.createSupplierContact(next.id, parsed(createContactSchema, { name: "Nora Ny", isPrimary: true }));
    const a = await article("PL-1");
    const { order: io, rows } = await order(old.id, [{ articleId: a.id, quantity: 5, unitPrice: 12.5 }]);
    const before = await stored(io.id);

    const p = await preview(io.id, next.id);
    expect(p.statusCode).toBe(200);
    expect(p.json()).toMatchObject({
      orderId: io.id,
      orderNumber: io.orderNumber,
      status: "draft",
      revertsToDraft: false,
      from: { supplierId: old.id, supplierName: "Gamla Stål AB", currency: "SEK", exchangeRate: 1 },
      to: { supplierId: next.id, supplierName: "Nya Stål AB", currency: "SEK", exchangeRate: 1 },
      terms: { deliveryTerm: "FCA · Fritt fraktföraren", paymentTerm: null, carrier: null, freightPaidByUs: true, yourReference: "Nora Ny" },
      blockers: [],
      rows: [
        {
          rowId: rows[0]!.id,
          articleNumber: "PL-1",
          quantity: 5,
          lego: false,
          before: { unitPrice: 12.5, setupPrice: null },
          after: { unitPrice: 12.5, setupPrice: null },
          origin: "unchanged",
          review: true,
          operationSupplierDiffers: false,
        },
      ],
    });
    // The preview wrote nothing.
    expect(await stored(io.id)).toEqual(before);

    const res = await call("POST", `/purchase-orders/${io.id}/change-supplier`, { supplierId: next.id, expected: expectedOf(p.json()) });
    expect(res.statusCode).toBe(200);
    expect(res.json().order).toMatchObject({ id: io.id, supplierId: next.id, supplierName: "Nya Stål AB", status: "draft" });
    expect(res.json().change.rows[0]).toMatchObject({ origin: "unchanged", review: true });

    const after = await stored(io.id);
    expect(after.order).toMatchObject({
      supplierId: next.id,
      status: "draft",
      currency: "SEK",
      exchangeRate: "1.000000",
      deliveryTermId: term.id,
      paymentTermId: null,
      carrierId: null,
      freightPaidByUs: true,
      yourReference: "Nora Ny",
      revision: before.order.revision + 1,
      // Untouched.
      ourReference: "Vår Inköpare",
      note: "Lossas på baksidan",
      expectedDeliveryDate: before.order.expectedDeliveryDate,
      orderNumber: io.orderNumber,
    });
    expect(after.rows).toEqual(before.rows);

    const log = await db.select().from(auditLog).where(eq(auditLog.action, "supplier_changed"));
    expect(log).toHaveLength(1);
    expect(log[0]).toMatchObject({ entityType: "purchase_order", entityId: io.orderNumber, userId });
    expect(log[0]!.detail).toEqual({
      before: { supplier: "Gamla Stål AB", currency: "SEK", exchangeRate: 1, status: "draft" },
      after: { supplier: "Nya Stål AB", currency: "SEK", exchangeRate: 1, status: "draft" },
      rows: [],
    });
  });

  it("takes a confirmed order back to draft (and it confirms again as usual)", async () => {
    const old = await supplier("Gamla AB", { freightPaidByUsDefault: true });
    await fixtures.createSupplierContact(old.id, parsed(createContactSchema, { name: "Gunnar Gammal", isPrimary: true }));
    const next = await supplier("Nya AB");
    const a = await article("PL-2");
    const { order: io } = await order(old.id, [{ articleId: a.id, quantity: 1, unitPrice: 10 }], { confirm: true });
    expect((await stored(io.id)).order).toMatchObject({ yourReference: "Gunnar Gammal", freightPaidByUs: true });
    expect((await stored(io.id)).order.confirmedAt).not.toBeNull();

    const p = await preview(io.id, next.id);
    expect(p.json()).toMatchObject({ status: "confirmed", revertsToDraft: true, blockers: [] });
    const res = await change(io.id, next.id);
    expect(res.statusCode).toBe(200);
    // The new supplier has no huvudkontakt and no frakt-förval: both cleared.
    expect((await stored(io.id)).order).toMatchObject({ supplierId: next.id, status: "draft", yourReference: null, freightPaidByUs: false });
    // No longer confirmed: an Ångra inleverans later would not give Bekräftad back.
    expect((await stored(io.id)).order.confirmedAt).toBeNull();
    const [log] = await db.select().from(auditLog).where(eq(auditLog.action, "supplier_changed"));
    expect(log!.detail).toMatchObject({ before: { status: "confirmed" }, after: { status: "draft" } });

    expect((await call("POST", `/purchase-orders/${io.id}/confirm`)).statusCode).toBe(200);
    expect((await stored(io.id)).order.status).toBe("confirmed");
  });

  it("takes a Skickad order back to draft — the old supplier has it and must be told", async () => {
    const old = await supplier("Gamla AB");
    const next = await supplier("Nya AB");
    const a = await article("PL-3");
    const { order: io } = await order(old.id, [{ articleId: a.id, quantity: 1, unitPrice: 10 }]);
    // Skickad = the mailed Utkast (2026-11-23).
    await db.update(purchaseOrders).set({ status: "sent" }).where(eq(purchaseOrders.id, io.id));

    const p = await preview(io.id, next.id);
    expect(p.json()).toMatchObject({ status: "sent", revertsToDraft: true, blockers: [] });
    expect((await change(io.id, next.id)).statusCode).toBe(200);
    expect((await stored(io.id)).order).toMatchObject({ supplierId: next.id, status: "draft" });
  });

  it("clears Bekräftat leveransdatum on the order and the rows (the old supplier's promise) and leaves Önskat", async () => {
    const old = await supplier("Gamla AB");
    const next = await supplier("Nya AB");
    const a = await article("DT-1");
    const { order: io, rows } = await order(
      old.id,
      [
        { articleId: a.id, quantity: 1, unitPrice: 10 },
        { articleId: a.id, quantity: 2, unitPrice: 10 },
      ],
      { confirm: true }
    );
    // Without any confirmed date the preview says nothing is cleared.
    expect((await preview(io.id, next.id)).json()).toMatchObject({ clearsConfirmedDates: false, confirmedDeliveryDate: null });
    const seen = (await preview(io.id, next.id)).json() as SupplierChangePreview;

    await db
      .update(purchaseOrders)
      .set({ expectedDeliveryDate: "2031-03-03", confirmedDeliveryDate: "2031-03-10" })
      .where(eq(purchaseOrders.id, io.id));
    await db
      .update(purchaseOrderRows)
      .set({ expectedDeliveryDate: "2031-03-05", confirmedDeliveryDate: "2031-03-12" })
      .where(eq(purchaseOrderRows.id, rows[1]!.id));
    const p = (await preview(io.id, next.id)).json() as SupplierChangePreview;
    expect(p).toMatchObject({ clearsConfirmedDates: true, confirmedDeliveryDate: "2031-03-10" });
    expect(p.rows.map((r) => r.confirmedDeliveryDate)).toEqual([null, "2031-03-12"]);

    // The dates are not part of what must still hold: the preview made
    // before they were set goes through, and they are cleared all the same.
    const res = await call("POST", `/purchase-orders/${io.id}/change-supplier`, { supplierId: next.id, expected: expectedOf(seen) });
    expect(res.statusCode).toBe(200);
    expect(res.json().change).toMatchObject({ clearsConfirmedDates: true });
    const after = await stored(io.id);
    expect(after.order).toMatchObject({ supplierId: next.id, expectedDeliveryDate: "2031-03-03", confirmedDeliveryDate: null });
    expect(after.rows.map((r) => [r.expectedDeliveryDate, r.confirmedDeliveryDate])).toEqual([
      [null, null],
      ["2031-03-05", null],
    ]);
    const [log] = await db.select().from(auditLog).where(eq(auditLog.action, "supplier_changed"));
    expect(log!.detail).toMatchObject({
      before: { status: "confirmed", confirmedDeliveryDate: "2031-03-10" },
      clearedConfirmedDates: [{ articleNumber: "DT-1", confirmedDeliveryDate: "2031-03-12" }],
    });
  });

  it.each(["received", "closed", "cancelled", "partially_received"] as const)("refuses an order in status %s", async (status) => {
    const old = await supplier("Gamla AB");
    const next = await supplier("Nya AB");
    const a = await article("PL-3");
    const { order: io } = await order(old.id, [{ articleId: a.id, quantity: 1, unitPrice: 10 }]);
    await db.update(purchaseOrders).set({ status }).where(eq(purchaseOrders.id, io.id));

    const p = await preview(io.id, next.id);
    expect(p.statusCode).toBe(200);
    expect(p.json().blockers).toEqual([
      { code: "invalid-status-transition", message: "Leverantören kan bara bytas på en inköpsorder i Utkast eller Bekräftad." },
    ]);
    const res = await call("POST", `/purchase-orders/${io.id}/change-supplier`, { supplierId: next.id, expected: expectedOf(p.json()) });
    expect(res.statusCode).toBe(409);
    expect(res.json().code).toBe("invalid-status-transition");
    expect((await stored(io.id)).order).toMatchObject({ supplierId: old.id, status });
  });

  it("400 for the supplier the order already has, 404 for an unknown supplier or order, 400 for an inactive supplier", async () => {
    const old = await supplier("Gamla AB");
    const inactive = await supplier("Vilande AB", { active: false });
    const a = await article("PL-4");
    const { order: io } = await order(old.id, [{ articleId: a.id, quantity: 1, unitPrice: 10 }]);
    const expected = { supplierId: old.id, currency: "SEK", exchangeRate: 1, rows: [] };

    for (const res of [
      await preview(io.id, old.id),
      await call("POST", `/purchase-orders/${io.id}/change-supplier`, { supplierId: old.id, expected }),
    ]) {
      expect(res.statusCode).toBe(400);
      expect(res.json().code).toBe("purchase-order-same-supplier");
    }
    const unknown = crypto.randomUUID();
    expect((await preview(io.id, unknown)).json().code).toBe("supplier-not-found");
    expect((await preview(io.id, unknown)).statusCode).toBe(404);
    expect((await preview(unknown, old.id)).statusCode).toBe(404);
    expect((await preview(unknown, old.id)).json().code).toBe("purchase-order-not-found");
    const res = await preview(io.id, inactive.id);
    expect(res.statusCode).toBe(400);
    expect(res.json().code).toBe("supplier-inactive");
    // A body with unknown fields is a validation error.
    expect((await call("POST", `/purchase-orders/${io.id}/change-supplier/preview`, { supplierId: old.id, x: 1 })).statusCode).toBe(400);
    expect((await stored(io.id)).order.supplierId).toBe(old.id);
  });
});

describe("the blockers", () => {
  async function fixture(confirm = true) {
    const old = await supplier("Gamla AB");
    const next = await supplier("Nya AB");
    const a = await article(`ART-${crypto.randomUUID().slice(0, 6)}`);
    const made = await order(old.id, [{ articleId: a.id, quantity: 10, unitPrice: 10 }], { confirm });
    return { old, next, a, io: made.order, row: made.rows[0]! };
  }

  async function expectBlocked(orderId: string, supplierId: string, oldSupplierId: string, code: string) {
    const p = await preview(orderId, supplierId);
    expect(p.statusCode).toBe(200);
    expect(p.json().blockers.map((b: { code: string }) => b.code)).toEqual([code]);
    const res = await call("POST", `/purchase-orders/${orderId}/change-supplier`, { supplierId, expected: expectedOf(p.json()) });
    expect(res.statusCode).toBe(409);
    expect(res.json().code).toBe(code);
    expect(res.json().blockers).toEqual(p.json().blockers);
    expect(res.json().error).toBe(p.json().blockers[0].message);
    expect((await stored(orderId)).order.supplierId).toBe(oldSupplierId);
    expect(await db.select().from(auditLog).where(eq(auditLog.action, "supplier_changed"))).toHaveLength(0);
  }

  it("a live receipt blocks; an undone one does not", async () => {
    const f = await fixture();
    const received = await call("POST", `/purchase-orders/${f.io.id}/rows/${f.row.id}/receive`, { quantity: 10 });
    expect(received.statusCode).toBeLessThan(300);
    // Fully received: the status blocks first, the receipt second.
    expect((await preview(f.io.id, f.next.id)).json().blockers.map((b: { code: string }) => b.code)).toEqual([
      "invalid-status-transition",
      "purchase-order-has-receipts",
    ]);
    const [receipt] = await db.select().from(purchaseReceipts).where(eq(purchaseReceipts.purchaseOrderId, f.io.id));
    expect((await call("POST", `/purchase-orders/${f.io.id}/receipts/${receipt!.id}/undo`)).statusCode).toBe(200);
    expect((await stored(f.io.id)).order.status).toBe("confirmed");

    const res = await change(f.io.id, f.next.id);
    expect(res.statusCode).toBe(200);
    expect((await stored(f.io.id)).order).toMatchObject({ supplierId: f.next.id, status: "draft" });
  });

  it("a receipt on a confirmed order whose status was set back by hand still blocks", async () => {
    const f = await fixture();
    expect((await call("POST", `/purchase-orders/${f.io.id}/rows/${f.row.id}/receive`, { quantity: 3 })).statusCode).toBeLessThan(300);
    expect((await call("POST", `/purchase-orders/${f.io.id}/set-status`, { status: "confirmed" })).statusCode).toBe(200);
    await expectBlocked(f.io.id, f.next.id, f.old.id, "purchase-order-has-receipts");
  });

  it("a live dispatch to the subcontractor blocks; an undone one does not", async () => {
    const old = await supplier("Gamla Lego AB");
    const next = await supplier("Nya Lego AB");
    const f = await legoOrder(old.id);
    const dispatched = await call("POST", `/purchase-orders/${f.io.id}/dispatches`, { rows: [{ rowId: f.row.id, quantity: 4, parcels: 1 }] });
    expect(dispatched.statusCode).toBeLessThan(300);
    await expectBlocked(f.io.id, next.id, old.id, "purchase-order-has-dispatches");

    expect((await call("POST", `/purchase-orders/${f.io.id}/dispatches/${dispatched.json().id}/undo`)).statusCode).toBe(200);
    expect((await change(f.io.id, next.id)).statusCode).toBe(200);
    expect((await stored(f.io.id)).order.supplierId).toBe(next.id);
  });

  it("a supplier invoice matched against a row blocks (draft too); a cancelled one does not", async () => {
    const f = await fixture();
    const invoice = await call("POST", "/supplier-invoices", {
      supplierId: f.old.id,
      invoiceNumber: "F-1001",
      invoiceDate: TODAY,
      rows: [{ articleId: f.a.id, purchaseOrderRowId: f.row.id, description: "Plåt", quantity: 10, unitPrice: 10 }],
    });
    expect(invoice.statusCode).toBe(201);
    const p = await preview(f.io.id, f.next.id);
    expect(p.json().blockers[0].message).toBe(
      `Ordern är kopplad till leverantörsfaktura ${invoice.json().registrationNumber} — ta bort kopplingen eller avbryt fakturan innan leverantören byts.`
    );
    await expectBlocked(f.io.id, f.next.id, f.old.id, "purchase-order-has-supplier-invoices");

    expect((await call("POST", `/supplier-invoices/${invoice.json().id}/cancel`)).statusCode).toBe(200);
    expect((await change(f.io.id, f.next.id)).statusCode).toBe(200);
  });

  it("a supplier invoice that names the order in its header blocks too", async () => {
    const f = await fixture();
    const invoice = await call("POST", "/supplier-invoices", {
      supplierId: f.old.id,
      invoiceNumber: "F-1002",
      invoiceDate: TODAY,
      purchaseOrderId: f.io.id,
      rows: [],
    });
    expect(invoice.statusCode).toBe(201);
    await expectBlocked(f.io.id, f.next.id, f.old.id, "purchase-order-has-supplier-invoices");
  });

  it("a deviation at the current supplier that points at the order blocks; a cancelled one does not", async () => {
    const f = await fixture(false);
    const deviation = await call("POST", "/deviations", { type: "supplier", title: "Fel antal", supplierId: f.old.id, purchaseOrderId: f.io.id });
    expect(deviation.statusCode).toBe(201);
    await expectBlocked(f.io.id, f.next.id, f.old.id, "purchase-order-has-deviations");
    expect((await call("POST", `/deviations/${deviation.json().id}/cancel`, { reason: "Fel order" })).statusCode).toBe(200);
    expect((await change(f.io.id, f.next.id)).statusCode).toBe(200);
  });
});

describe("the prices", () => {
  it("a row the new supplier has a catalog price for gets it — staffel for the row's quantity; a row without keeps its price and is marked", async () => {
    const old = await supplier("Gamla AB");
    const next = await supplier("Nya AB");
    const [base, tiered, none] = [await article("KAT-1"), await article("KAT-2"), await article("KAT-3")];
    await catalog(base.id, next.id, { price: 8.25 });
    await catalog(tiered.id, next.id, { price: 20, priceBreaks: [{ fromQuantity: 10, price: 18 }, { fromQuantity: 100, price: 15.5555 }] });
    // The OLD supplier's catalog is never read.
    await catalog(none.id, old.id, { price: 1 });
    const { order: io, rows } = await order(old.id, [
      { articleId: base.id, quantity: 3, unitPrice: 10 },
      { articleId: tiered.id, quantity: 50, unitPrice: 22 },
      { articleId: tiered.id, quantity: 100, unitPrice: 22 },
      { articleId: none.id, quantity: 2, unitPrice: 7.1234 },
    ]);

    const p = (await preview(io.id, next.id)).json() as SupplierChangePreview;
    expect(p.rows.map((r) => [r.after.unitPrice, r.origin, r.review])).toEqual([
      [8.25, "catalog", false],
      [18, "catalog", false],
      [15.5555, "catalog", false],
      [7.1234, "unchanged", true],
    ]);
    expect((await change(io.id, next.id)).statusCode).toBe(200);
    const after = await stored(io.id);
    expect(after.rows.map((r) => r.unitPrice)).toEqual(["8.2500", "18.0000", "15.5555", "7.1234"]);
    // Quantities, units and dates are not touched.
    expect(after.rows.map((r) => r.quantityOrdered)).toEqual(rows.map((r) => r.quantityOrdered));

    const [log] = await db.select().from(auditLog).where(eq(auditLog.action, "supplier_changed"));
    expect((log!.detail as { rows: unknown[] }).rows).toEqual([
      { articleNumber: "KAT-1", origin: "catalog", before: { unitPrice: 10 }, after: { unitPrice: 8.25 } },
      { articleNumber: "KAT-2", origin: "catalog", before: { unitPrice: 22 }, after: { unitPrice: 18 } },
      { articleNumber: "KAT-2", origin: "catalog", before: { unitPrice: 22 }, after: { unitPrice: 15.5555 } },
    ]);
  });

  it("SEK → EUR: today's rate, catalog prices in EUR, the others converted to the same value in kronor; a catalog price in another currency is not used", async () => {
    await eurRate(11.5);
    const old = await supplier("Svenska AB");
    const next = await supplier("Euro GmbH", { currency: "EUR" });
    const [inEur, inSek, none] = [await article("EUR-1"), await article("EUR-2"), await article("EUR-3")];
    await catalog(inEur.id, next.id, { price: 4.2, currency: "EUR" });
    // The new supplier's catalog row is in kronor — not the order's new currency.
    await catalog(inSek.id, next.id, { price: 99, currency: "SEK" });
    const { order: io } = await order(
      old.id,
      [
        { articleId: inEur.id, quantity: 1, unitPrice: 50 },
        { articleId: inSek.id, quantity: 1, unitPrice: 115 },
        { articleId: none.id, quantity: 1, unitPrice: 10 },
      ],
      { confirm: true }
    );

    const p = (await preview(io.id, next.id)).json() as SupplierChangePreview;
    expect(p.to).toMatchObject({ currency: "EUR", exchangeRate: 11.5 });
    expect(p.rows.map((r) => [r.after.unitPrice, r.origin, r.review])).toEqual([
      [4.2, "catalog", false],
      [10, "converted", true],
      // 10 / 11.5 = 0.869565… → four decimals.
      [0.8696, "converted", true],
    ]);
    expect((await change(io.id, next.id)).statusCode).toBe(200);
    const after = await stored(io.id);
    expect(after.order).toMatchObject({ currency: "EUR", exchangeRate: "11.500000", status: "draft", supplierId: next.id });
    expect(after.rows.map((r) => r.unitPrice)).toEqual(["4.2000", "10.0000", "0.8696"]);
    const [log] = await db.select().from(auditLog).where(eq(auditLog.action, "supplier_changed"));
    expect(log!.detail).toMatchObject({
      before: { currency: "SEK", exchangeRate: 1, status: "confirmed" },
      after: { currency: "EUR", exchangeRate: 11.5, status: "draft" },
    });
  });

  it("EUR → SEK: the rate becomes 1 and the prices kronor at the order's own rate; a SEK catalog price is used", async () => {
    const old = await supplier("Euro GmbH", { currency: "EUR" });
    const next = await supplier("Svenska AB");
    const [plain, listed] = [await article("SEK-1"), await article("SEK-2")];
    await catalog(listed.id, next.id, { price: 77 });
    const { order: io } = await order(
      old.id,
      [
        { articleId: plain.id, quantity: 1, unitPrice: 5.1234 },
        { articleId: listed.id, quantity: 1, unitPrice: 6 },
      ],
      { exchangeRate: 10.5 }
    );
    expect((await stored(io.id)).order).toMatchObject({ currency: "EUR", exchangeRate: "10.500000" });

    const p = (await preview(io.id, next.id)).json() as SupplierChangePreview;
    expect(p.from).toMatchObject({ currency: "EUR", exchangeRate: 10.5 });
    expect(p.to).toMatchObject({ currency: "SEK", exchangeRate: 1 });
    expect(p.rows.map((r) => [r.after.unitPrice, r.origin])).toEqual([
      [53.7957, "converted"],
      [77, "catalog"],
    ]);
    // A SEK order only takes 1.
    const wrong = await preview(io.id, next.id, { exchangeRate: 2 });
    expect(wrong.statusCode).toBe(400);
    expect(wrong.json().code).toBe("purchase-order-exchange-rate");
    expect((await change(io.id, next.id)).statusCode).toBe(200);
    const after = await stored(io.id);
    expect(after.order).toMatchObject({ currency: "SEK", exchangeRate: "1.000000" });
    expect(after.rows.map((r) => r.unitPrice)).toEqual(["53.7957", "77.0000"]);
  });

  it("the same foreign currency keeps the order's own rate and prices", async () => {
    await eurRate(12);
    const old = await supplier("Euro GmbH", { currency: "EUR" });
    const next = await supplier("Autre SA", { currency: "EUR" });
    const a = await article("EE-1");
    const { order: io } = await order(old.id, [{ articleId: a.id, quantity: 1, unitPrice: 5 }], { exchangeRate: 10.5 });
    const p = (await preview(io.id, next.id)).json() as SupplierChangePreview;
    expect(p.to).toMatchObject({ currency: "EUR", exchangeRate: 10.5 });
    expect(p.rows[0]).toMatchObject({ after: { unitPrice: 5 }, origin: "unchanged" });
    expect((await change(io.id, next.id)).statusCode).toBe(200);
    expect((await stored(io.id)).order).toMatchObject({ supplierId: next.id, currency: "EUR", exchangeRate: "10.500000" });
  });

  it("no rate today ⇒ 409 exchange-rate-unavailable and nothing written; a typed rate goes through", async () => {
    const old = await supplier("Svenska AB");
    const next = await supplier("Euro GmbH", { currency: "EUR" });
    const a = await article("NR-1");
    const { order: io } = await order(old.id, [{ articleId: a.id, quantity: 1, unitPrice: 100 }]);
    const before = await stored(io.id);

    const p = await preview(io.id, next.id);
    expect(p.statusCode).toBe(409);
    expect(p.json()).toMatchObject({ code: "exchange-rate-unavailable", currency: "EUR", date: TODAY });
    const res = await call("POST", `/purchase-orders/${io.id}/change-supplier`, {
      supplierId: next.id,
      expected: { supplierId: old.id, currency: "EUR", exchangeRate: 10, rows: [{ rowId: before.rows[0]!.id, unitPrice: 10, setupPrice: null }] },
    });
    expect(res.statusCode).toBe(409);
    expect(res.json().code).toBe("exchange-rate-unavailable");
    expect(await stored(io.id)).toEqual(before);
    expect(await db.select().from(auditLog).where(eq(auditLog.action, "supplier_changed"))).toHaveLength(0);

    const typed = await change(io.id, next.id, { exchangeRate: 10 });
    expect(typed.statusCode).toBe(200);
    const after = await stored(io.id);
    expect(after.order).toMatchObject({ currency: "EUR", exchangeRate: "10.000000" });
    expect(after.rows[0]!.unitPrice).toBe("10.0000");
  });
});

describe("legoinköpsorder", () => {
  it("a lego row never reads the catalog; its ställpris is converted with two decimals and the TO operation's supplier is left as it is", async () => {
    await eurRate(11);
    const old = await supplier("Gamla Lego AB");
    const next = await supplier("Lego GmbH", { currency: "EUR" });
    const f = await legoOrder(old.id);
    // A catalog price for the manufactured article prices the article, not the operation.
    await catalog(f.parent.id, next.id, { price: 1, currency: "EUR" });

    const p = (await preview(f.io.id, next.id)).json() as SupplierChangePreview;
    expect(p.rows).toHaveLength(1);
    expect(p.rows[0]).toMatchObject({
      lego: true,
      before: { unitPrice: 100, setupPrice: 500 },
      // 100 / 11 = 9.0909…, 500 / 11 = 45.4545… → 45.45.
      after: { unitPrice: 9.0909, setupPrice: 45.45 },
      origin: "converted",
      review: true,
      operationSupplierDiffers: true,
    });
    expect((await change(f.io.id, next.id)).statusCode).toBe(200);
    const after = await stored(f.io.id);
    expect(after.rows[0]).toMatchObject({ unitPrice: "9.0909", setupPrice: "45.45", moOperationId: f.legoOp.id });
    const [op] = await db.select().from(moOperations).where(eq(moOperations.id, f.legoOp.id));
    expect(op!.subcontractSupplierId).toBe(old.id);
    const [log] = await db.select().from(auditLog).where(eq(auditLog.action, "supplier_changed"));
    expect((log!.detail as { rows: unknown[] }).rows).toEqual([
      {
        articleNumber: f.parent.articleNumber,
        origin: "converted",
        before: { unitPrice: 100, setupPrice: 500 },
        after: { unitPrice: 9.0909, setupPrice: 45.45 },
      },
    ]);
    // The TO card's legoinköp still lists the order.
    const lego = await call("GET", `/manufacturing-orders/${f.legoOp.manufacturingOrderId}/lego-purchases`);
    expect(lego.json()[0].purchaseOrders).toMatchObject([{ purchaseOrderId: f.io.id, status: "draft" }]);
  });

  it("in the same currency the lego row keeps price and ställpris; an order made from an inquiry leaves the inquiry as it was", async () => {
    const old = await supplier("Gamla AB");
    const next = await supplier("Nya AB");
    const a = await article("RFQ-1");
    const created = await fixtures.createInquiry(
      parsed(createInquirySchema, { supplierId: old.id, rows: [{ articleId: a.id, quantity: 5, unitPrice: 20 }] }),
      userId
    );
    await fixtures.sendInquiry(created.inquiry.id);
    const io = await fixtures.convertInquiryToOrder(created.inquiry.id, userId);
    expect((await change(io.id, next.id)).statusCode).toBe(200);
    const [inquiry] = await db.select().from(inquiries).where(eq(inquiries.id, created.inquiry.id));
    expect(inquiry).toMatchObject({ supplierId: old.id, status: "ordered", purchaseOrderId: io.id });

    const legoOld = await supplier("Gamla Lego AB");
    const f = await legoOrder(legoOld.id);
    const p = (await preview(f.io.id, next.id)).json() as SupplierChangePreview;
    expect(p.rows[0]).toMatchObject({ after: { unitPrice: 100, setupPrice: 500 }, origin: "unchanged", review: true });
  });
});

describe("the preview must still hold", () => {
  it("409 with the fresh preview when a price, the rate or the supplier moved since the preview — nothing written", async () => {
    await eurRate(10);
    const old = await supplier("Gamla AB");
    const next = await supplier("Euro GmbH", { currency: "EUR" });
    const a = await article("ST-1");
    const { order: io, rows } = await order(old.id, [{ articleId: a.id, quantity: 1, unitPrice: 100 }]);
    const seen = (await preview(io.id, next.id)).json() as SupplierChangePreview;
    expect(seen.rows[0]!.after.unitPrice).toBe(10);

    // The row's price is changed on the card meanwhile.
    expect((await call("PATCH", `/purchase-orders/${io.id}/rows/${rows[0]!.id}`, { unitPrice: 200, bumpRevision: false })).statusCode).toBe(200);
    const before = await stored(io.id);
    let res = await call("POST", `/purchase-orders/${io.id}/change-supplier`, { supplierId: next.id, expected: expectedOf(seen) });
    expect(res.statusCode).toBe(409);
    expect(res.json().code).toBe("purchase-order-supplier-change-stale");
    expect(res.json().preview.rows[0].after.unitPrice).toBe(20);
    expect(await stored(io.id)).toEqual(before);

    // The rate changes.
    const fresh = res.json().preview as SupplierChangePreview;
    await db.update(exchangeRates).set({ rate: "8" }).where(eq(exchangeRates.currency, "EUR"));
    res = await call("POST", `/purchase-orders/${io.id}/change-supplier`, { supplierId: next.id, expected: expectedOf(fresh) });
    expect(res.statusCode).toBe(409);
    expect(res.json().preview.to.exchangeRate).toBe(8);
    expect(res.json().preview.rows[0].after.unitPrice).toBe(25);

    // A row is added.
    const latest = res.json().preview as SupplierChangePreview;
    await fixtures.addRow(io.id, { articleId: a.id, quantity: 2, unitPrice: 8 });
    res = await call("POST", `/purchase-orders/${io.id}/change-supplier`, { supplierId: next.id, expected: expectedOf(latest) });
    expect(res.statusCode).toBe(409);
    expect(res.json().preview.rows).toHaveLength(2);

    // The new supplier's catalog gets a price.
    const withRow = res.json().preview as SupplierChangePreview;
    await catalog(a.id, next.id, { price: 3, currency: "EUR" });
    res = await call("POST", `/purchase-orders/${io.id}/change-supplier`, { supplierId: next.id, expected: expectedOf(withRow) });
    expect(res.statusCode).toBe(409);
    expect(res.json().preview.rows.map((r: { origin: string }) => r.origin)).toEqual(["catalog", "catalog"]);

    // The order was moved to a third supplier: the preview's "from" is gone.
    const third = await supplier("Tredje AB");
    const final = res.json().preview as SupplierChangePreview;
    expect((await change(io.id, third.id)).statusCode).toBe(200);
    res = await call("POST", `/purchase-orders/${io.id}/change-supplier`, { supplierId: next.id, expected: expectedOf(final) });
    expect(res.statusCode).toBe(409);
    expect(res.json().code).toBe("purchase-order-supplier-change-stale");
    expect(res.json().preview.from.supplierId).toBe(third.id);
    expect((await stored(io.id)).order.supplierId).toBe(third.id);
    expect(await db.select().from(auditLog).where(eq(auditLog.action, "supplier_changed"))).toHaveLength(1);

    // …and with the fresh preview it goes through.
    res = await call("POST", `/purchase-orders/${io.id}/change-supplier`, { supplierId: next.id, expected: expectedOf(res.json().preview) });
    expect(res.statusCode).toBe(200);
  });

  it("the plan is tried again under the locks: a price committed while the change waits makes it stale", async () => {
    const old = await supplier("Gamla AB");
    const next = await supplier("Nya AB");
    const a = await article("LK-1");
    const { order: io, rows } = await order(old.id, [{ articleId: a.id, quantity: 1, unitPrice: 100 }]);
    const seen = (await preview(io.id, next.id)).json() as SupplierChangePreview;
    const { revision } = (await stored(io.id)).order;

    const res = await whileHolding(
      (tx) => tx.update(purchaseOrderRows).set({ unitPrice: "150" }).where(eq(purchaseOrderRows.id, rows[0]!.id)),
      () => call("POST", `/purchase-orders/${io.id}/change-supplier`, { supplierId: next.id, expected: expectedOf(seen) })
    );
    expect(res.statusCode).toBe(409);
    expect(res.json().code).toBe("purchase-order-supplier-change-stale");
    expect(res.json().preview.rows[0].after.unitPrice).toBe(150);
    expect((await stored(io.id)).order).toMatchObject({ supplierId: old.id, revision });
  });
});

describe("concurrency with a receipt", () => {
  async function fixture() {
    const old = await supplier("Gamla AB");
    const next = await supplier("Nya AB");
    const a = await article(`RC-${crypto.randomUUID().slice(0, 6)}`);
    const made = await order(old.id, [{ articleId: a.id, quantity: 10, unitPrice: 10 }], { confirm: true });
    const seen = (await preview(made.order.id, next.id)).json() as SupplierChangePreview;
    return { old, next, io: made.order, row: made.rows[0]!, seen };
  }
  const receive = (orderId: string, rowId: string) => call("POST", `/purchase-orders/${orderId}/rows/${rowId}/receive`, { quantity: 4 });
  const changeNow = (orderId: string, supplierId: string, seen: SupplierChangePreview) =>
    call("POST", `/purchase-orders/${orderId}/change-supplier`, { supplierId, expected: expectedOf(seen) });

  // One wins and the other is refused — never goods on an order that moved,
  // never a moved order with goods.
  async function expectConsistent(f: Awaited<ReturnType<typeof fixture>>, received: { statusCode: number }, changed: { statusCode: number }) {
    const after = await stored(f.io.id);
    const receipts = await db.select().from(purchaseReceipts).where(eq(purchaseReceipts.purchaseOrderId, f.io.id));
    if (changed.statusCode === 200) {
      expect(received.statusCode).toBe(409);
      expect(after.order).toMatchObject({ supplierId: f.next.id, status: "draft" });
      expect(receipts).toHaveLength(0);
      expect(after.rows[0]!.quantityReceived).toBe("0.0000");
    } else {
      expect(changed.statusCode).toBe(409);
      expect(received.statusCode).toBeLessThan(300);
      expect(after.order).toMatchObject({ supplierId: f.old.id, status: "partially_received" });
      expect(receipts).toHaveLength(1);
    }
    return changed.statusCode === 200 ? "change" : "receipt";
  }

  it("the change waits for a receipt holding the row and is then refused (rows before the order — no deadlock)", async () => {
    const f = await fixture();
    // The receipt's locks: row, then order.
    const changed = await whileHolding(
      async (tx) => {
        await tx.select().from(purchaseOrderRows).where(eq(purchaseOrderRows.id, f.row.id)).for("update");
        await tx.select().from(purchaseOrders).where(eq(purchaseOrders.id, f.io.id)).for("update");
        // What the receipt writes, committed with the holder.
        await tx.update(purchaseOrderRows).set({ quantityReceived: "4" }).where(eq(purchaseOrderRows.id, f.row.id));
        await tx.insert(purchaseReceipts).values({ purchaseOrderId: f.io.id, purchaseOrderRowId: f.row.id, quantity: "4" });
        await tx.update(purchaseOrders).set({ status: "partially_received" }).where(eq(purchaseOrders.id, f.io.id));
      },
      () => changeNow(f.io.id, f.next.id, f.seen)
    );
    expect(changed.statusCode).toBe(409);
    expect(changed.json().code).toBe("invalid-status-transition");
    expect(await expectConsistent(f, { statusCode: 201 }, changed)).toBe("receipt");
  });

  it("a receipt that waits for the change is refused on the order now in draft", async () => {
    const f = await fixture();
    // Hold the row so both queue behind it; the change is started first.
    let changing!: ReturnType<typeof changeNow>;
    const received = await whileHolding(
      (tx) => tx.select().from(purchaseOrderRows).where(eq(purchaseOrderRows.id, f.row.id)).for("update"),
      async () => {
        changing = changeNow(f.io.id, f.next.id, f.seen);
        await waitForLockWaiter(10_000, 1);
        return receive(f.io.id, f.row.id);
      },
      2
    );
    await expectConsistent(f, received, await changing);
  });

  it("a plain race ends with exactly one winner", async () => {
    for (let i = 0; i < 3; i++) {
      const f = await fixture();
      const [received, changed] = await Promise.all([receive(f.io.id, f.row.id), changeNow(f.io.id, f.next.id, f.seen)]);
      await expectConsistent(f, received, changed);
    }
  });

  it("two changes at once: one goes through, the other sees a stale preview or the same supplier", async () => {
    const f = await fixture();
    const { revision } = (await stored(f.io.id)).order;
    const [a, b] = await Promise.all([changeNow(f.io.id, f.next.id, f.seen), changeNow(f.io.id, f.next.id, f.seen)]);
    expect([a.statusCode, b.statusCode].sort()).toEqual([200, 400]);
    expect((await stored(f.io.id)).order).toMatchObject({ supplierId: f.next.id, revision: revision + 1 });
    expect(await db.select().from(auditLog).where(eq(auditLog.action, "supplier_changed"))).toHaveLength(1);
  });
});

describe("permissions", () => {
  it("needs Inköp; a read-only account may preview but not change", async () => {
    const old = await supplier("Gamla AB");
    const next = await supplier("Nya AB");
    const a = await article("PM-1");
    const { order: io } = await order(old.id, [{ articleId: a.id, quantity: 1, unitPrice: 10 }]);
    const seen = (await preview(io.id, next.id)).json() as SupplierChangePreview;
    const body = { supplierId: next.id, expected: expectedOf(seen) };

    const other = await userCookie(["forsaljning", "tillverkning"]);
    expect((await call("POST", `/purchase-orders/${io.id}/change-supplier/preview`, { supplierId: next.id }, other)).statusCode).toBe(403);
    expect((await call("POST", `/purchase-orders/${io.id}/change-supplier`, body, other)).statusCode).toBe(403);

    const readOnly = await userCookie(["inkop"], true);
    expect((await call("POST", `/purchase-orders/${io.id}/change-supplier/preview`, { supplierId: next.id }, readOnly)).statusCode).toBe(200);
    const refused = await call("POST", `/purchase-orders/${io.id}/change-supplier`, body, readOnly);
    expect(refused.statusCode).toBe(403);
    expect(refused.json().code).toBe("read-only-account");
    expect((await call("POST", `/purchase-orders/${io.id}/change-supplier`, {}, cookie)).statusCode).toBe(400);
    expect((await stored(io.id)).order.supplierId).toBe(old.id);

    const buyer = await userCookie(["inkop"]);
    expect((await call("POST", `/purchase-orders/${io.id}/change-supplier`, body, buyer)).statusCode).toBe(200);
    expect((await stored(io.id)).order.supplierId).toBe(next.id);
  });
});

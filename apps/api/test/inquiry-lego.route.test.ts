import { afterAll, beforeEach, describe, expect, it } from "vitest";
import Fastify from "fastify";
import { sql } from "drizzle-orm";
import { db } from "@navet/db";
import { testArticleService, testDocumentPdfService, testSystemService } from "./helpers/services.js";
import { createArticleRepository } from "../src/modules/article/repository/article.repository.js";
import { createArticleService } from "../src/modules/article/service/article.service.js";
import { createAuthRepository } from "../src/modules/auth/repository/auth.repository.js";
import { createMailRepository } from "../src/modules/mail/repository/mail.repository.js";
import { createMailService, type MailTransportFactory } from "../src/modules/mail/service/mail.service.js";
import { createManufacturingRepository } from "../src/modules/manufacturing/repository/manufacturing.repository.js";
import { createManufacturingService } from "../src/modules/manufacturing/service/manufacturing.service.js";
import { createPurchaseRepository } from "../src/modules/purchase/repository/purchase.repository.js";
import { createPurchaseService } from "../src/modules/purchase/service/purchase.service.js";
import { purchaseRoutes } from "../src/modules/purchase/routes/purchase.routes.js";
import { createRegisterRepository } from "../src/modules/register/repository/register.repository.js";
import { createRegisterService } from "../src/modules/register/service/register.service.js";
import { createSalesRepository } from "../src/modules/sales/repository/sales.repository.js";
import { markSalesOrderInProduction } from "../src/modules/sales/service/production-transition.js";

// Fix wave B: route-level coverage for the lego inquiry-row error mappings —
// previously only the service layer was covered (test/inquiry-lego.test.ts).
// App-boot pattern (bare Fastify + a fake req.user preHandler) copied from
// e3-sales-row-mo.route.test.ts / partner-number-conflict.route.test.ts.

const articleService = createArticleService(createArticleRepository(db));
const authRepo = createAuthRepository(db);
const registerService = createRegisterService(createRegisterRepository(db));
const salesRepository = createSalesRepository(db);
const purchaseRepository = createPurchaseRepository(db);

const fakeTransportFactory: MailTransportFactory = () => ({
  async sendMail() {
    /* no-op — these tests never send mail */
  },
});
const mailService = createMailService(createMailRepository(db), testSystemService, fakeTransportFactory);

const mfgService = createManufacturingService(createManufacturingRepository(db), testDocumentPdfService, testArticleService, {
  findRowForManufacturing: salesRepository.findRowForManufacturing,
  lockRowForManufacturing: salesRepository.lockRowForManufacturing,
  markInProduction: markSalesOrderInProduction,
});

const purchaseService = createPurchaseService(
  purchaseRepository,
  registerService,
  mailService,
  testDocumentPdfService,
  testArticleService,
  testSystemService,
  mfgService
);

const TRUNCATE = sql`TRUNCATE email_log, inquiry_rows, inquiries, purchase_order_rows, purchase_orders, mo_material_consumptions, mo_operation_scrap, mo_operations, manufacturing_orders, routing_operations, work_centers, production_groups, suppliers, articles, users CASCADE`;

beforeEach(async () => {
  await db.execute(TRUNCATE);
  await testSystemService.updateSettings({ smtpHost: "smtp.test.local", smtpFromEmail: "erp@test.local" });
});

afterAll(async () => {
  await db.execute(TRUNCATE);
});

async function makeUser() {
  return authRepo.create({
    email: `rfq-route-${crypto.randomUUID()}@example.com`,
    passwordHash: "not-a-real-hash",
    name: "Inköpare",
    role: "admin",
  });
}

async function makeSupplier() {
  return purchaseService.createSupplier({ name: "Lego AB", active: true });
}

// A manufactured article with one machine operation (10) and one lego
// operation (20) — same shape as inquiry-lego.test.ts's makeLegoRouting.
async function makeLegoRouting() {
  const supplier = await makeSupplier();
  const machine = await mfgService.createWorkCenter({ code: "100", name: "Svets", type: "machine", active: true });
  const lego = await mfgService.createWorkCenter({
    code: "900",
    name: "Ytbehandling AB",
    type: "subcontract",
    supplierId: supplier.id,
    active: true,
  });
  const parent = await articleService.createArticle({
    articleNumber: `LEGO-ROUTE-${crypto.randomUUID()}`,
    name: "Legodetalj",
    type: "manufactured",
    unit: "st",
    active: true,
  });
  const machineOp = await mfgService.createRoutingOperation(parent.id, {
    sequenceNo: 10,
    workCenterId: machine.id,
    setupTime: 10,
    runTimePerUnit: 2,
  });
  const routingLegoOp = await mfgService.createRoutingOperation(parent.id, {
    sequenceNo: 20,
    description: "Ytbehandling",
    workCenterId: lego.id,
    setupTime: 0,
    runTimePerUnit: 0,
    setupPrice: 500,
    unitPrice: 100,
  });
  return { supplier, machine, lego, parent, machineOp, routingLegoOp };
}

async function buildApp() {
  const routeUser = await makeUser();
  const app = Fastify();
  app.addHook("preHandler", async (req) => {
    req.user = routeUser as any;
  });
  await app.register(purchaseRoutes, { service: purchaseService });
  return { app, routeUser };
}

describe("POST /inquiries/:id/rows", () => {
  it("409s duplicate-inquiry-row when the article is already on the inquiry", async () => {
    const f = await makeLegoRouting();
    const { app } = await buildApp();
    const { inquiry } = await purchaseService.createInquiry(
      { supplierId: f.supplier.id, rows: [{ articleId: f.parent.id, quantity: 1 }] },
      (await makeUser()).id
    );

    const res = await app.inject({
      method: "POST",
      url: `/inquiries/${inquiry.id}/rows`,
      payload: { articleId: f.parent.id, quantity: 2 },
    });

    expect(res.statusCode).toBe(409);
    expect(res.json().code).toBe("duplicate-inquiry-row");
    await app.close();
  });

  it("404s lego-operation-not-found for an unknown routingOperationId", async () => {
    const f = await makeLegoRouting();
    const { app } = await buildApp();
    const { inquiry } = await purchaseService.createInquiry(
      { supplierId: f.supplier.id, rows: [{ articleId: f.parent.id, quantity: 1, routingOperationId: f.routingLegoOp.id }] },
      (await makeUser()).id
    );
    const other = await articleService.createArticle({
      articleNumber: `OTHER-ROUTE-${crypto.randomUUID()}`,
      name: "Annan",
      type: "manufactured",
      unit: "st",
      active: true,
    });

    const res = await app.inject({
      method: "POST",
      url: `/inquiries/${inquiry.id}/rows`,
      payload: { articleId: other.id, quantity: 1, routingOperationId: "00000000-0000-0000-0000-000000000000" },
    });

    expect(res.statusCode).toBe(404);
    expect(res.json().code).toBe("lego-operation-not-found");
    await app.close();
  });

  it("400s not-lego-operation for a machine operation", async () => {
    const f = await makeLegoRouting();
    const { app } = await buildApp();
    // A different article on the inquiry so the row itself is new — the
    // machine-operation guard fires before any duplicate-article check
    // (resolveLegoRow validates before the row is ever inserted).
    const plain = await articleService.createArticle({
      articleNumber: `PLAIN-ROUTE-${crypto.randomUUID()}`,
      name: "Vanlig",
      type: "purchased",
      unit: "st",
      active: true,
    });
    const { inquiry } = await purchaseService.createInquiry(
      { supplierId: f.supplier.id, rows: [{ articleId: plain.id, quantity: 1 }] },
      (await makeUser()).id
    );

    const res = await app.inject({
      method: "POST",
      url: `/inquiries/${inquiry.id}/rows`,
      payload: { articleId: f.parent.id, quantity: 1, routingOperationId: f.machineOp.id },
    });

    expect(res.statusCode).toBe(400);
    expect(res.json().code).toBe("not-lego-operation");
    await app.close();
  });
});

describe("POST /inquiries/:id/rows/:rowId/apply-price-to-routing", () => {
  it("404s inquiry-row-not-found for an unknown row", async () => {
    const f = await makeLegoRouting();
    const { app } = await buildApp();
    const { inquiry } = await purchaseService.createInquiry(
      { supplierId: f.supplier.id, rows: [{ articleId: f.parent.id, quantity: 1 }] },
      (await makeUser()).id
    );

    const res = await app.inject({
      method: "POST",
      url: `/inquiries/${inquiry.id}/rows/00000000-0000-0000-0000-000000000000/apply-price-to-routing`,
    });

    expect(res.statusCode).toBe(404);
    expect(res.json().code).toBe("inquiry-row-not-found");
    await app.close();
  });

  it("409s inquiry-row-price-not-applicable for a draft inquiry's lego row", async () => {
    const f = await makeLegoRouting();
    const { app } = await buildApp();
    const { inquiry, rows } = await purchaseService.createInquiry(
      { supplierId: f.supplier.id, rows: [{ articleId: f.parent.id, quantity: 1, routingOperationId: f.routingLegoOp.id }] },
      (await makeUser()).id
    );

    const res = await app.inject({
      method: "POST",
      url: `/inquiries/${inquiry.id}/rows/${rows[0]!.id}/apply-price-to-routing`,
    });

    expect(res.statusCode).toBe(409);
    expect(res.json().code).toBe("inquiry-row-price-not-applicable");
    await app.close();
  });
});

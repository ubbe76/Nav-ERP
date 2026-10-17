import { afterAll, beforeEach, describe, expect, it } from "vitest";
import Fastify from "fastify";
import { ZodError } from "zod";
import { sql } from "drizzle-orm";
import { daySchedules, db } from "@navet/db";
import { loadDeliveryContext } from "../src/modules/system/repository/delivery-context.js";
import { salesRoutes } from "../src/modules/sales/routes/sales.routes.js";
import { createSalesRepository } from "../src/modules/sales/repository/sales.repository.js";
import { createSalesService } from "../src/modules/sales/service/sales.service.js";
import { purchaseRoutes } from "../src/modules/purchase/routes/purchase.routes.js";
import { createPurchaseRepository } from "../src/modules/purchase/repository/purchase.repository.js";
import { createPurchaseService } from "../src/modules/purchase/service/purchase.service.js";
import { createArticleRepository } from "../src/modules/article/repository/article.repository.js";
import { createArticleService } from "../src/modules/article/service/article.service.js";
import { createRegisterRepository } from "../src/modules/register/repository/register.repository.js";
import { createRegisterService } from "../src/modules/register/service/register.service.js";
import { createMailRepository } from "../src/modules/mail/repository/mail.repository.js";
import { createMailService, type MailTransportFactory } from "../src/modules/mail/service/mail.service.js";
import { createDocumentPdfService } from "../src/modules/mail/service/document-pdf.js";
import { createSystemRepository } from "../src/modules/system/repository/system.repository.js";
import { createSystemService } from "../src/modules/system/service/system.service.js";
import { createStockRepository } from "../src/modules/stock/repository/stock.repository.js";
import { createStockService } from "../src/modules/stock/service/stock.service.js";
import { resolvePrice } from "../src/modules/sales/service/price-resolver.js";

// Fasta leveransdagar: the delivery fields on suppliers and customers —
// normalization (sorted, no duplicates), null = the system default, and
// zod's bounds. App boot copied from partner-number-conflict.route.test.ts.

const articleService = createArticleService(createArticleRepository(db));
const registerService = createRegisterService(createRegisterRepository(db));
const systemService = createSystemService(createSystemRepository(db));

const fakeTransportFactory: MailTransportFactory = () => ({
  async sendMail() {
    /* no-op — these tests never send mail */
  },
});
const mailService = createMailService(createMailRepository(db), systemService, fakeTransportFactory);
const documentPdfService = createDocumentPdfService(systemService);
const stockService = createStockService(createStockRepository(db));

const salesService = createSalesService(
  createSalesRepository(db),
  registerService,
  mailService,
  documentPdfService,
  stockService,
  articleService,
  systemService,
  (query) => resolvePrice(db, query)
);

const purchaseService = createPurchaseService(
  createPurchaseRepository(db),
  registerService,
  mailService,
  documentPdfService,
  articleService,
  systemService,
  // Lego (Etapp G): SubcontractOperationReporter — never reached in this
  // suite, and loud if it ever is.
  {
    reportOperationQuantities: async () => { throw new Error("SubcontractOperationReporter not wired in this test"); },
    assertMaterialBeforeSubcontractReceipt: async () => {},
    undoPurchaseReceiptReportInTx: async () => { throw new Error("SubcontractOperationReporter not wired in this test"); },
    updateRoutingOperation: async () => { throw new Error("RoutingPriceWriter not wired in this test"); },
  }
);

const app = Fastify();
// The bare app lacks app.ts's error handler; map zod like it does.
app.setErrorHandler((err, _req, reply) => {
  if (err instanceof ZodError) return reply.code(400).send({ code: "validation-failed" });
  throw err;
});
app.register(salesRoutes, { service: salesService });
app.register(purchaseRoutes, { service: purchaseService });

const TRUNCATE = sql`TRUNCATE suppliers, customers, holidays, day_schedules CASCADE`;

beforeEach(async () => {
  await db.execute(TRUNCATE);
});

afterAll(async () => {
  await db.execute(TRUNCATE);
});

const PARTNERS = [
  { kind: "suppliers", create: () => purchaseService.createSupplier({ name: "Leverantör AB", active: true }) },
  { kind: "customers", create: () => salesService.createCustomer({ name: "Kund AB", active: true }) },
] as const;

describe.each(PARTNERS)("delivery fields on /$kind", ({ kind, create }) => {
  it("a new partner has no fixed days and follows the system defaults", async () => {
    const partner = await create();
    const res = await app.inject({ method: "GET", url: `/${kind}/${partner.id}` });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ deliveryWeekdays: [], deliveryDayMode: null, transitDays: null });
  });

  it("PATCH sorts and dedupes the weekdays, and null clears mode and transit", async () => {
    const partner = await create();
    const patched = await app.inject({
      method: "PATCH",
      url: `/${kind}/${partner.id}`,
      payload: { deliveryWeekdays: [4, 1, 1], deliveryDayMode: "dispatch", transitDays: 2 },
    });
    expect(patched.statusCode).toBe(200);
    const got = await app.inject({ method: "GET", url: `/${kind}/${partner.id}` });
    expect(got.json()).toMatchObject({ deliveryWeekdays: [1, 4], deliveryDayMode: "dispatch", transitDays: 2 });

    await app.inject({ method: "PATCH", url: `/${kind}/${partner.id}`, payload: { deliveryDayMode: null, transitDays: null } });
    const cleared = await app.inject({ method: "GET", url: `/${kind}/${partner.id}` });
    expect(cleared.json()).toMatchObject({ deliveryWeekdays: [1, 4], deliveryDayMode: null, transitDays: null });
  });

  it("POST accepts the fields", async () => {
    const res = await app.inject({
      method: "POST",
      url: `/${kind}`,
      payload: { name: "Med dagar AB", deliveryWeekdays: [5, 2], deliveryDayMode: "arrival", transitDays: 0 },
    });
    expect(res.statusCode).toBe(201);
    expect(res.json()).toMatchObject({ deliveryWeekdays: [2, 5], deliveryDayMode: "arrival", transitDays: 0 });
  });

  it.each([{ deliveryWeekdays: [0] }, { deliveryWeekdays: [8] }, { transitDays: 61 }, { deliveryDayMode: "sometimes" }])(
    "400s %o",
    async (payload) => {
      const partner = await create();
      const res = await app.inject({ method: "PATCH", url: `/${kind}/${partner.id}`, payload });
      expect(res.statusCode).toBe(400);
    }
  );
});

describe("loadDeliveryContext", () => {
  it("loads only full-day holidays in the window", async () => {
    const [schedule] = await db
      .insert(daySchedules)
      .values({ code: "KORT", name: "Kortdag", startTime: "07:00", endTime: "12:00" })
      .returning();
    await db.execute(sql`INSERT INTO holidays (date, name) VALUES ('2026-12-25', 'Juldagen'), ('2027-01-01', 'Nyårsdagen')`);
    await db.execute(sql`INSERT INTO holidays (date, name, day_schedule_id) VALUES ('2026-12-24', 'Julafton', ${schedule!.id})`);

    const ctx = await loadDeliveryContext(db, { from: "2026-12-01", to: "2026-12-31" });
    expect([...ctx.offDays]).toEqual(["2026-12-25"]);
  });
});

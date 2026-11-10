import {
  articleForecastUpdateSchema,
  completeOperationSchema,
  createArticleSchema,
  createArticleSupplierSchema,
  createInquirySchema,
  createPlanningOrdersSchema,
  createSupplierSchema,
  createWeekScheduleSchema,
  createWorkCenterSchema,
  listRequirementsQuerySchema,
  missingComponentsSchema,
  updateInquiryRowSchema,
} from "@navet/shared";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import Fastify from "fastify";
import { and, eq, sql } from "drizzle-orm";
import { ZodError } from "zod";
import { auditLog, db, exchangeRates, manufacturingOrders, moOperationPlanWeeks, moOperations, purchaseOrders } from "@navet/db";
import { testArticleService, testDocumentPdfService, testSystemService } from "./helpers/services.js";
import { parsed } from "./helpers/parsed.js";
import { CONFIGURED_MFG_TRUNCATE, confirmedRow, mfg as configuredMfg, resetCostingSettings } from "./helpers/configured-manufacturing.js";
import {
  configurator,
  makeCustomer,
  makeUser as makeConfiguredUser,
  purchaseService as configuredPurchaseService,
  resetConfiguredRows,
  salesService,
} from "./helpers/configured-rows.js";
import { createArticleRepository } from "../src/modules/article/repository/article.repository.js";
import { createArticleService } from "../src/modules/article/service/article.service.js";
import { createAuthRepository } from "../src/modules/auth/repository/auth.repository.js";
import { createMailRepository } from "../src/modules/mail/repository/mail.repository.js";
import { createMailService } from "../src/modules/mail/service/mail.service.js";
import { createManufacturingRepository } from "../src/modules/manufacturing/repository/manufacturing.repository.js";
import { createManufacturingService } from "../src/modules/manufacturing/service/manufacturing.service.js";
import { createPlanningRepository } from "../src/modules/planning/repository/planning.repository.js";
import { planningRoutes } from "../src/modules/planning/routes/planning.routes.js";
import { firmClosingBalance, type ArticleOverviewRow } from "../src/modules/planning/service/article-overview.js";
import { planMissingComponents, type MissingArticle } from "../src/modules/planning/service/missing-components.js";
import {
  createPlanningService,
  legoPriceConverter,
  PlanWeekNoCapacityError,
  STALE_PROPOSAL_MESSAGE,
  type ManufacturingPlanReader,
  type PlanningService,
} from "../src/modules/planning/service/planning.service.js";
import { buildBomIndex } from "../src/modules/planning/service/requirements-calc.js";
import { createPurchaseRepository } from "../src/modules/purchase/repository/purchase.repository.js";
import { purchaseRoutes } from "../src/modules/purchase/routes/purchase.routes.js";
import { createPurchaseService } from "../src/modules/purchase/service/purchase.service.js";
import { createRegisterRepository } from "../src/modules/register/repository/register.repository.js";
import { createRegisterService } from "../src/modules/register/service/register.service.js";
import { createSalesRepository } from "../src/modules/sales/repository/sales.repository.js";
import { markSalesOrderInProduction } from "../src/modules/sales/service/production-transition.js";
import { createStockRepository } from "../src/modules/stock/repository/stock.repository.js";
import { createStockService } from "../src/modules/stock/service/stock.service.js";
import { createAuditRepository } from "../src/modules/system/repository/audit.repository.js";
import { stockholmToday } from "../src/modules/system/service/delivery-days.js";
import { createExchangeRateService, ExchangeRateUnavailableError } from "../src/modules/system/service/exchange-rates.js";
import { createScheduleRepository } from "../src/modules/timereport/repository/schedule.repository.js";
import { createTimeReportRepository } from "../src/modules/timereport/repository/timereport.repository.js";
import { createScheduleService } from "../src/modules/timereport/service/schedule.service.js";

// Planeringsgranskningen 2026-11-10: the proposal key and the serialized
// Skapa ordrar, lego prices in kronor against an order / an inquiry in
// another currency, Skapa saknade halvfabrikat against the FIRM balance and
// inactive articles, the cache drops, the `kind` filter, Flytta to a week
// without capacity and the partly received TO of a configured row.
//
// Two clocks: the purchase side reads today's rate (stockholmToday), so the
// Skapa ordrar / lego / inquiry cases run on the real day; the plan and the
// pegging cases pin "today" to Monday 2030-03-04 like the other plan suites.
const REAL_TODAY = stockholmToday();
const W1 = "2030-03-04";
const W2 = "2030-03-11";
const W3 = "2030-03-18";
const PINNED_TODAY = W1;

const auditRepository = createAuditRepository(db);
const articleService = createArticleService(createArticleRepository(db));
const authRepo = createAuthRepository(db);
const registerService = createRegisterService(createRegisterRepository(db));
const stockService = createStockService(createStockRepository(db));
const salesRepository = createSalesRepository(db);
const salesOrderLinks = {
  findRowForManufacturing: salesRepository.findRowForManufacturing,
  lockRowForManufacturing: salesRepository.lockRowForManufacturing,
  markInProduction: markSalesOrderInProduction,
};
// Without a plan reader: the TOs of the purchase-side cases (and the
// "someone else's" TOs of the pegging cases) are unplanned.
const mfgService = createManufacturingService(createManufacturingRepository(db), testDocumentPdfService, testArticleService, salesOrderLinks);
// The same late binding as app.ts: a new TO is planned by the planning
// service, which is built after the manufacturing service.
const planReaderRef: { current: ManufacturingPlanReader | null } = { current: null };
const plannedMfgService = createManufacturingService(
  createManufacturingRepository(db),
  testDocumentPdfService,
  testArticleService,
  salesOrderLinks,
  undefined,
  undefined,
  undefined,
  undefined,
  {
    planNewOrderInTx: (tx, moId, given, opts) => planReaderRef.current!.planNewOrderInTx(tx, moId, given, opts),
    replanOrderInTx: (tx, moId) => planReaderRef.current!.replanOrderInTx(tx, moId),
    orderPlanSummaries: (ids) => planReaderRef.current!.orderPlanSummaries(ids),
    componentLateOrders: (ids) => planReaderRef.current!.componentLateOrders!(ids),
  }
);
// The real rate service on the test database: manual rates only — Riksbanken
// never answers here.
const rates = createExchangeRateService({
  db,
  fetch: async () => {
    throw new Error("Riksbanken is not reachable from the tests");
  },
  timeoutMs: 50,
  log: () => {},
});
const purchaseService = createPurchaseService(
  createPurchaseRepository(db),
  registerService,
  createMailService(createMailRepository(db), testSystemService),
  testDocumentPdfService,
  testArticleService,
  testSystemService,
  mfgService,
  auditRepository,
  rates
);
const scheduleService = createScheduleService(createScheduleRepository(db), createTimeReportRepository(db), {
  isDateLocked: async () => false,
});

// Skapa ordrar on the real day, through the real purchase service.
const planningService = createPlanningService(createPlanningRepository(db), {
  purchase: purchaseService,
  manufacturing: mfgService,
  requirementsCacheMs: 0,
});
// The plan and the pegging on the pinned day. Nothing here buys anything.
const purchaseNotUsed = {
  createPurchaseOrder: async () => {
    throw new Error("PurchaseOrderCreator.createPurchaseOrder is not wired in this test");
  },
  addRow: async () => {
    throw new Error("PurchaseOrderCreator.addRow is not wired in this test");
  },
  cancel: async () => {
    throw new Error("PurchaseOrderCreator.cancel is not wired in this test");
  },
};
function buildPinnedPlanning(requirementsCacheMs: number) {
  return createPlanningService(createPlanningRepository(db), {
    purchase: purchaseNotUsed,
    manufacturing: plannedMfgService,
    requirementsCacheMs,
    today: () => PINNED_TODAY,
    audit: auditRepository,
    salesOrderDates: salesService,
  });
}
const pinnedPlanning = buildPinnedPlanning(0);
planReaderRef.current = pinnedPlanning;

const TABLES = sql`TRUNCATE audit_log, email_log, exchange_rates, article_forecasts, inquiry_rows, inquiries, purchase_receipts,
  mo_report_materials, mo_reports, purchase_order_rows, purchase_orders, article_suppliers, suppliers, mo_operation_plan_weeks,
  mo_material_consumptions, mo_operation_scrap, mo_operations, manufacturing_orders, sales_order_rows, sales_orders, customers,
  routing_operations, work_centers, production_groups, holidays, week_schedule_days, week_schedules, day_schedule_breaks,
  day_schedules, stock_transactions, stock_locations, warehouses, bom_components, configurator_templates, articles, users CASCADE`;

let user: { id: string };

beforeEach(async () => {
  await db.execute(TABLES);
  user = await authRepo.create({ email: `plan-${crypto.randomUUID()}@example.com`, passwordHash: "x", name: "Planerare", role: "admin" });
});
afterAll(async () => {
  await db.execute(TABLES);
});

const suffix = () => crypto.randomUUID().slice(0, 8);

async function supplier(currency = "SEK", name = `Leverantör ${currency}`) {
  return purchaseService.createSupplier(parsed(createSupplierSchema, { name, currency, active: true }));
}

async function article(prefix: string, type: "purchased" | "manufactured", extra: { forecastControlled?: boolean; manufacturingLeadTimeDays?: number } = {}) {
  return articleService.createArticle(
    parsed(createArticleSchema, { articleNumber: `${prefix}-${suffix()}`, name: prefix, type, active: true, ...extra })
  );
}

async function eurRate(rate: number) {
  await db.insert(exchangeRates).values({ currency: "EUR", date: REAL_TODAY, rate: String(rate), source: "manual" });
}

const requirements = (service: PlanningService, query: { refresh?: "true"; kind?: "article" | "lego" } = {}) =>
  service.listRequirements(parsed(listRequirementsQuerySchema, { limit: 500, offset: 0, showAll: "true", ...query }));

const allManufacturingOrders = () => db.select({ id: manufacturingOrders.id, articleId: manufacturingOrders.articleId }).from(manufacturingOrders);
const allPurchaseOrders = () => db.select({ id: purchaseOrders.id, supplierId: purchaseOrders.supplierId }).from(purchaseOrders);

// Fastify with the planning routes over the given service, as the real app
// answers them (zod ⇒ 400, the user set by the auth plugin).
async function planningApp(service: PlanningService) {
  const app = Fastify();
  app.setErrorHandler((err, _req, reply) => {
    if (err instanceof ZodError) return reply.code(400).send({ error: "Validation failed", code: "validation-failed", issues: err.issues });
    throw err;
  });
  app.decorateRequest("user", null);
  app.addHook("preHandler", async (req) => {
    req.user = { id: user.id } as never;
  });
  await app.register(planningRoutes, { service });
  return app;
}

// ---------------------------------------------------------------------------
// 1. Skapa ordrar and the proposal's key
// ---------------------------------------------------------------------------

// A released TO of P (5 st) that needs one bought K and one made M each:
// the list proposes an IO for K and a TO for M.
async function proposalWorld() {
  const s = await supplier();
  const machine = await mfgService.createWorkCenter(parsed(createWorkCenterSchema, { code: "100", name: "Svets", type: "machine", active: true }));
  const bought = await article("KOP", "purchased");
  await purchaseService.addArticleSupplier(bought.id, parsed(createArticleSupplierSchema, { supplierId: s.id, price: 5, isPrimary: true }));
  const made = await article("TILLV", "manufactured");
  await mfgService.createRoutingOperation(made.id, { sequenceNo: 10, workCenterId: machine.id, setupTime: 0, runTimePerUnit: 1 });
  const product = await article("PROD", "manufactured");
  await mfgService.createRoutingOperation(product.id, { sequenceNo: 10, workCenterId: machine.id, setupTime: 0, runTimePerUnit: 1 });
  await articleService.addBomComponent(product.id, { componentArticleId: bought.id, quantity: 1 });
  await articleService.addBomComponent(product.id, { componentArticleId: made.id, quantity: 1 });
  const parent = await mfgService.createManufacturingOrder({ articleId: product.id, quantity: 5 }, user.id);
  return { supplier: s, bought, made, product, parent };
}

// The two proposals as the page posts them: quantity, kind and key from the list.
async function listedProposals(world: Awaited<ReturnType<typeof proposalWorld>>, withKey: boolean) {
  const { rows } = await requirements(planningService, { refresh: "true" });
  const pick = (articleId: string, kind: "purchase" | "manufacture") => {
    const row = rows.find((r) => r.articleId === articleId && r.proposalKind === kind);
    expect(row, `a ${kind} proposal row`).toBeDefined();
    expect(row!.proposals).toHaveLength(1);
    const proposal = row!.proposals[0]!;
    expect(proposal.quantity).toBe(5);
    expect(proposal.key.startsWith(`${kind}:${articleId}:`)).toBe(true);
    return { articleId, quantity: proposal.quantity, kind, ...(withKey ? { key: proposal.key } : {}) };
  };
  return parsed(createPlanningOrdersSchema, { proposals: [pick(world.bought.id, "purchase"), pick(world.made.id, "manufacture")] });
}

describe("1 — Skapa ordrar och förslagets nyckel", () => {
  it("a keyed proposal is created once: the same call again is refused per proposal with the stale message", async () => {
    const world = await proposalWorld();
    const input = await listedProposals(world, true);

    const first = await planningService.createOrdersFromProposals(input, user.id);
    expect(first.errors).toEqual([]);
    expect(first.purchaseOrders.map((o) => [o.supplierId, o.rowCount])).toEqual([[world.supplier.id, 1]]);
    expect(first.manufacturingOrders.map((o) => o.articleNumber)).toEqual([world.made.articleNumber]);

    // The second click (or another tab) posts the same keys: the fresh
    // recomputation no longer has them — the draft IO and the new TO cover.
    const second = await planningService.createOrdersFromProposals(input, user.id);
    expect(second.purchaseOrders).toEqual([]);
    expect(second.manufacturingOrders).toEqual([]);
    expect(second.errors).toEqual([
      { articleId: world.bought.id, articleNumber: world.bought.articleNumber, message: STALE_PROPOSAL_MESSAGE },
      { articleId: world.made.id, articleNumber: world.made.articleNumber, message: STALE_PROPOSAL_MESSAGE },
    ]);
    expect(await allPurchaseOrders()).toHaveLength(1);
    // The parent and the one TO for M.
    expect((await allManufacturingOrders()).filter((mo) => mo.articleId === world.made.id)).toHaveLength(1);
    expect(await allManufacturingOrders()).toHaveLength(2);
  });

  it("two calls at once with the same keys give exactly one order each (serializedOrderCreation)", async () => {
    const world = await proposalWorld();
    const input = await listedProposals(world, true);

    const results = await Promise.all([
      planningService.createOrdersFromProposals(input, user.id),
      planningService.createOrdersFromProposals(input, user.id),
    ]);
    expect(results.flatMap((r) => r.purchaseOrders)).toHaveLength(1);
    expect(results.flatMap((r) => r.manufacturingOrders)).toHaveLength(1);
    // One of the calls made both orders, the other was refused for both.
    expect(results.map((r) => r.errors.length).sort()).toEqual([0, 2]);
    expect(results.flatMap((r) => r.errors).map((e) => e.message)).toEqual([STALE_PROPOSAL_MESSAGE, STALE_PROPOSAL_MESSAGE]);
    expect(await allPurchaseOrders()).toHaveLength(1);
    expect((await allManufacturingOrders()).filter((mo) => mo.articleId === world.made.id)).toHaveLength(1);
  });

  it("a serialized call that throws does not block the next one", async () => {
    const world = await proposalWorld();
    const input = await listedProposals(world, true);
    // The queue chains on the previous call whatever its outcome.
    const failing = createPlanningService(
      {
        ...createPlanningRepository(db),
        async articleInfoForIds() {
          throw new Error("boom before anything is created");
        },
      },
      { purchase: purchaseService, manufacturing: mfgService, requirementsCacheMs: 0 }
    );
    await expect(failing.createOrdersFromProposals(input, user.id)).rejects.toThrow("boom before anything is created");
    await expect(failing.createOrdersFromProposals(input, user.id)).rejects.toThrow("boom before anything is created");
    expect(await allPurchaseOrders()).toHaveLength(0);
  });

  it("without a key nothing is checked — two calls give two orders (integrations, as before)", async () => {
    const world = await proposalWorld();
    const input = await listedProposals(world, false);

    const first = await planningService.createOrdersFromProposals(input, user.id);
    const second = await planningService.createOrdersFromProposals(input, user.id);
    expect([first.errors, second.errors]).toEqual([[], []]);
    expect(await allPurchaseOrders()).toHaveLength(2);
    expect((await allManufacturingOrders()).filter((mo) => mo.articleId === world.made.id)).toHaveLength(2);
  });

  it("a mixed call refuses only the stale keyed proposal", async () => {
    const world = await proposalWorld();
    const input = await listedProposals(world, true);
    const [purchase, manufacture] = input.proposals;
    await planningService.createOrdersFromProposals(parsed(createPlanningOrdersSchema, { proposals: [manufacture!] }), user.id);

    // M is covered now (stale), K is still proposed (live).
    const result = await planningService.createOrdersFromProposals(input, user.id);
    expect(result.errors).toEqual([{ articleId: world.made.id, articleNumber: world.made.articleNumber, message: STALE_PROPOSAL_MESSAGE }]);
    expect(result.purchaseOrders).toHaveLength(1);
    expect(result.manufacturingOrders).toEqual([]);
    expect(purchase!.kind).toBe("purchase");
  });
});

// ---------------------------------------------------------------------------
// 2 + 3. The lego proposal: its key, and kronor on an order in another currency
// ---------------------------------------------------------------------------

// Legoartikel: operation 10 on a machine, 20 on a legoresurs with the given
// supplier and prices (kronor); a released TO of `quantity`.
async function legoWorld(opts: { currency?: string; unitPrice?: number; setupPrice?: number; quantity?: number; codes?: [string, string]; legoSupplierId?: string } = {}) {
  const legoSupplier = opts.legoSupplierId ? { id: opts.legoSupplierId } : await supplier(opts.currency ?? "SEK", `Lego ${suffix()}`);
  const [machineCode, legoCode] = opts.codes ?? ["100", "900"];
  const machine = await mfgService.createWorkCenter(parsed(createWorkCenterSchema, { code: machineCode, name: "Svets", type: "machine", active: true }));
  const lego = await mfgService.createWorkCenter(
    parsed(createWorkCenterSchema, { code: legoCode, name: "Ytbehandling AB", type: "subcontract", supplierId: legoSupplier.id, active: true })
  );
  const parent = await article("LEGO", "manufactured");
  await mfgService.createRoutingOperation(parent.id, { sequenceNo: 10, workCenterId: machine.id, setupTime: 0, runTimePerUnit: 1 });
  const routingLegoOp = await mfgService.createRoutingOperation(parent.id, {
    sequenceNo: 20,
    workCenterId: lego.id,
    setupTime: 0,
    runTimePerUnit: 0,
    setupPrice: opts.setupPrice ?? 500,
    unitPrice: opts.unitPrice ?? 100,
  });
  const mo = await mfgService.createManufacturingOrder({ articleId: parent.id, quantity: opts.quantity ?? 10 }, user.id);
  const legoOp = (await mfgService.listOperations(mo.id)).find((op) => op.sequenceNo === 20)!;
  return { legoSupplier, machine, lego, parent, routingLegoOp, mo, legoOp };
}

const legoProposal = (world: { parent: { id: string }; legoOp: { id: string } }, quantity: number, key?: string) =>
  parsed(createPlanningOrdersSchema, {
    proposals: [{ articleId: world.parent.id, quantity, kind: "subcontract", moOperationId: world.legoOp.id, ...(key ? { key } : {}) }],
  });

describe("2 — legoförslaget och nyckeln", () => {
  it("a keyed lego proposal is created once; without a key (the TO card) a second IO is made on purpose", async () => {
    const world = await legoWorld({ quantity: 10 });
    const key = `subcontract:${world.legoOp.id}`;
    const listed = (await requirements(planningService, { refresh: "true" })).rows.find((r) => r.proposalKind === "subcontract");
    expect(listed).toMatchObject({ articleId: world.parent.id, proposalQuantity: 10 });
    expect(listed!.proposals.map((p) => [p.key, p.quantity])).toEqual([[key, 10]]);

    const first = await planningService.createOrdersFromProposals(legoProposal(world, 10, key), user.id);
    expect(first.errors).toEqual([]);
    expect(first.purchaseOrders.map((o) => [o.supplierId, o.rowCount])).toEqual([[world.legoSupplier.id, 1]]);
    const rows = await purchaseService.listRows(first.purchaseOrders[0]!.id);
    expect(rows.map((r) => [r.articleId, Number(r.quantityOrdered), r.moOperationId])).toEqual([[world.parent.id, 10, world.legoOp.id]]);
    // Everything is ordered: the operation has left the list.
    expect((await requirements(planningService, { refresh: "true" })).rows.some((r) => r.proposalKind === "subcontract")).toBe(false);

    // The list's proposal again (a repeated click, another tab): refused.
    const again = await planningService.createOrdersFromProposals(legoProposal(world, 10, key), user.id);
    expect(again.purchaseOrders).toEqual([]);
    expect(again.errors).toEqual([{ articleId: world.parent.id, articleNumber: world.parent.articleNumber, message: STALE_PROPOSAL_MESSAGE }]);
    expect(await allPurchaseOrders()).toHaveLength(1);

    // Without a key — TO-kortets Skapa inköpsorder — the operation may be
    // ordered once more although everything is already ordered (the manual
    // says so): no cap, a second IO.
    const fromCard = await planningService.createOrdersFromProposals(legoProposal(world, 10), user.id);
    expect(fromCard.errors).toEqual([]);
    expect(fromCard.purchaseOrders).toHaveLength(1);
    expect(fromCard.purchaseOrders[0]!.id).not.toBe(first.purchaseOrders[0]!.id);
    expect(await allPurchaseOrders()).toHaveLength(2);
  });
});

describe("3 — legopriset i kronor på en inköpsorder i annan valuta", () => {
  it("legoPriceConverter: SEK and no currency unchanged, another currency divided by the order's rate at the column's scale", () => {
    expect(legoPriceConverter({ currency: "SEK", exchangeRate: "1.000000" })(115, 4)).toBe(115);
    // A SEK order is never divided, whatever rate it carries.
    expect(legoPriceConverter({ currency: "SEK", exchangeRate: 2 })(115, 4)).toBe(115);
    // Fixtures without a currency: as before.
    expect(legoPriceConverter({})(115, 4)).toBe(115);
    expect(legoPriceConverter({ exchangeRate: "11.5" })(230, 2)).toBe(230);

    const eur = legoPriceConverter({ currency: "EUR", exchangeRate: "11.500000" });
    expect(eur(115, 4)).toBe(10);
    expect(eur(230, 2)).toBe(20);
    // À-pris 4 decimals, ställpris 2.
    expect(eur(100, 4)).toBe(8.6957);
    expect(eur(100, 2)).toBe(8.7);
    expect(eur(0, 4)).toBe(0);
    expect(legoPriceConverter({ currency: "EUR", exchangeRate: 11.5 })(115, 4)).toBe(10);

    // No usable rate ⇒ 0, like a catalog price in another currency.
    expect(legoPriceConverter({ currency: "EUR" })(115, 4)).toBe(0);
    expect(legoPriceConverter({ currency: "EUR", exchangeRate: 0 })(115, 4)).toBe(0);
    expect(legoPriceConverter({ currency: "EUR", exchangeRate: "0.000000" })(230, 2)).toBe(0);
    expect(legoPriceConverter({ currency: "EUR", exchangeRate: -1 })(115, 4)).toBe(0);
    expect(legoPriceConverter({ currency: "EUR", exchangeRate: "abc" })(115, 4)).toBe(0);
  });

  it("Skapa ordrar converts the operation's kronor with the order's own rate", async () => {
    await eurRate(11.5);
    const world = await legoWorld({ currency: "EUR", unitPrice: 115, setupPrice: 230, quantity: 4 });

    const result = await planningService.createOrdersFromProposals(legoProposal(world, 4), user.id);
    expect(result.errors).toEqual([]);
    const order = await purchaseService.getPurchaseOrder(result.purchaseOrders[0]!.id);
    expect(order).toMatchObject({ currency: "EUR", exchangeRate: "11.500000" });
    const rows = await purchaseService.listRows(order!.id);
    expect(rows.map((r) => [r.unitPrice, r.setupPrice, r.moOperationId])).toEqual([["10.0000", "20.00", world.legoOp.id]]);
    // The operation itself still carries kronor.
    const operation = await mfgService.getOperation(world.legoOp.id);
    expect([operation!.unitPrice, operation!.setupPrice]).toEqual(["115.0000", "230.00"]);
  });

  it("a SEK order gets the operation's prices as they are; no rate for the day is an error row, not an order", async () => {
    const sek = await legoWorld({ unitPrice: 115, setupPrice: 230, quantity: 4 });
    const created = await planningService.createOrdersFromProposals(legoProposal(sek, 4), user.id);
    const rows = await purchaseService.listRows(created.purchaseOrders[0]!.id);
    expect(rows.map((r) => [r.unitPrice, r.setupPrice])).toEqual([["115.0000", "230.00"]]);

    const eur = await legoWorld({ currency: "EUR", quantity: 4, codes: ["101", "901"] });
    const refused = await planningService.createOrdersFromProposals(legoProposal(eur, 4), user.id);
    expect(refused.purchaseOrders).toEqual([]);
    expect(refused.errors).toHaveLength(1);
    expect(refused.errors[0]!.message).toMatch(/Ingen kurs för EUR/);
    expect(await allPurchaseOrders()).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// 4. Prisåterföringen from an inquiry, and the default ställpris on its lego row
// ---------------------------------------------------------------------------

async function purchaseApp() {
  const app = Fastify();
  app.addHook("preHandler", async (req) => {
    req.user = { id: user.id } as never;
  });
  await app.register(purchaseRoutes, { service: purchaseService });
  return app;
}

const routingOperation = async (articleId: string, id: string) => (await mfgService.listRoutingOperations(articleId)).find((op) => op.id === id)!;
const appliedAudit = () =>
  db
    .select({ detail: auditLog.detail, userId: auditLog.userId })
    .from(auditLog)
    .where(and(eq(auditLog.entityType, "inquiry"), eq(auditLog.action, "price_applied_to_routing")));

// An answered inquiry to a supplier in `currency` for the lego operation of
// a fresh article (the beredning: 100 kr/st, 500 kr ställpris), answered
// with 10 per unit and a ställpris of 20 in the supplier's currency.
async function answeredInquiry(currency: string) {
  const world = await legoWorld();
  const quoted = await supplier(currency, `Offererande ${currency}`);
  const { inquiry, rows } = await purchaseService.createInquiry(
    parsed(createInquirySchema, {
      supplierId: quoted.id,
      rows: [{ articleId: world.parent.id, quantity: 10, routingOperationId: world.routingLegoOp.id, setupPrice: 20 }],
    }),
    user.id
  );
  await purchaseService.sendInquiry(inquiry.id, user.id);
  await purchaseService.markInquiryAnswered(inquiry.id, user.id);
  await purchaseService.updateInquiryRow(inquiry.id, rows[0]!.id, parsed(updateInquiryRowSchema, { unitPrice: 10 }));
  return { ...world, quoted, inquiry, row: rows[0]! };
}

describe("4 — prisåterföringen från en förfrågan i annan valuta", () => {
  it("an answer in EUR lands on the beredning in kronor, and the audit row says what it was", async () => {
    await eurRate(11.5);
    const f = await answeredInquiry("EUR");

    await purchaseService.applyInquiryRowPriceToRouting(f.inquiry.id, f.row.id, user.id);

    const op = await routingOperation(f.parent.id, f.routingLegoOp.id);
    expect([op.unitPrice, op.setupPrice, op.subcontractSupplierId]).toEqual(["115.0000", "230.00", f.quoted.id]);
    const audit = await appliedAudit();
    expect(audit).toHaveLength(1);
    expect(audit[0]!.userId).toBe(user.id);
    expect(audit[0]!.detail).toMatchObject({
      routingOperationId: f.routingLegoOp.id,
      supplierId: f.quoted.id,
      currency: "EUR",
      exchangeRate: 11.5,
      unitPriceSek: 115,
      setupPriceSek: 230,
    });
    // The answer itself, in the supplier's currency, is still there.
    const detail = audit[0]!.detail as { unitPrice: unknown; setupPrice: unknown };
    expect([Number(detail.unitPrice), Number(detail.setupPrice)]).toEqual([10, 20]);
  });

  it("without a rate for the day: 409 exchange-rate-unavailable and the beredning untouched", async () => {
    const f = await answeredInquiry("EUR");

    await expect(purchaseService.applyInquiryRowPriceToRouting(f.inquiry.id, f.row.id, user.id)).rejects.toBeInstanceOf(ExchangeRateUnavailableError);
    const app = await purchaseApp();
    const res = await app.inject({ method: "POST", url: `/inquiries/${f.inquiry.id}/rows/${f.row.id}/apply-price-to-routing` });
    expect([res.statusCode, res.json().code]).toEqual([409, "exchange-rate-unavailable"]);
    await app.close();

    const op = await routingOperation(f.parent.id, f.routingLegoOp.id);
    expect([op.unitPrice, op.setupPrice, op.subcontractSupplierId]).toEqual(["100.0000", "500.00", f.legoSupplier.id]);
    expect(await appliedAudit()).toEqual([]);
  });

  it("a SEK answer is written as it is, with no currency fields in the audit row", async () => {
    const f = await answeredInquiry("SEK");
    await purchaseService.applyInquiryRowPriceToRouting(f.inquiry.id, f.row.id, user.id);

    const op = await routingOperation(f.parent.id, f.routingLegoOp.id);
    expect([op.unitPrice, op.setupPrice, op.subcontractSupplierId]).toEqual(["10.0000", "20.00", f.quoted.id]);
    const audit = await appliedAudit();
    expect(audit).toHaveLength(1);
    const detail = audit[0]!.detail as Record<string, unknown>;
    expect(Object.keys(detail).sort()).toEqual(["routingOperationId", "setupPrice", "supplierId", "unitPrice"]);
  });
});

describe("4 — standardställpriset på en förfrågans legorad", () => {
  // The beredning's ställpris is 230 kr; the rows below give none of their own.
  async function inquiryWithDefault(currency: string, codes: [string, string] = ["100", "900"]) {
    const world = await legoWorld({ setupPrice: 230, codes });
    const asked = await supplier(currency, `Tillfrågad ${currency} ${suffix()}`);
    const created = await purchaseService.createInquiry(
      parsed(createInquirySchema, { supplierId: asked.id, rows: [{ articleId: world.parent.id, quantity: 10, routingOperationId: world.routingLegoOp.id }] }),
      user.id
    );
    return { ...world, asked, ...created };
  }

  it("EUR: the operation's kronor divided by today's rate, 2 decimals — also on a row added later and on a TO operation", async () => {
    await eurRate(11.5);
    const f = await inquiryWithDefault("EUR");
    expect(f.rows.map((r) => [r.setupPrice, r.unitPrice, r.routingOperationId])).toEqual([["20.00", null, f.routingLegoOp.id]]);

    // Added afterwards, against the TO's operation (the snapshot carries the same 230 kr).
    const added = await purchaseService.addInquiryRow(f.inquiry.id, { articleId: f.parent.id, quantity: 4, moOperationId: f.legoOp.id });
    expect(added.setupPrice).toBe("20.00");
    // An entered ställpris always wins over the default.
    const own = await purchaseService.addInquiryRow(f.inquiry.id, { articleId: f.parent.id, quantity: 4, routingOperationId: f.routingLegoOp.id, setupPrice: 33 });
    expect(own.setupPrice).toBe("33.00");

    // 230 / 11.25 = 20.444… ⇒ 20.44.
    await db.update(exchangeRates).set({ rate: "11.25" }).where(eq(exchangeRates.currency, "EUR"));
    const rounded = await purchaseService.addInquiryRow(f.inquiry.id, { articleId: f.parent.id, quantity: 4, routingOperationId: f.routingLegoOp.id });
    expect(rounded.setupPrice).toBe("20.44");
  });

  it("EUR without a rate: no default, the row is created anyway", async () => {
    const f = await inquiryWithDefault("EUR");
    expect(f.rows).toHaveLength(1);
    expect(f.rows[0]!.setupPrice).toBeNull();
    const added = await purchaseService.addInquiryRow(f.inquiry.id, { articleId: f.parent.id, quantity: 4, routingOperationId: f.routingLegoOp.id });
    expect(added.setupPrice).toBeNull();
  });

  it("SEK: the operation's ställpris as it is", async () => {
    const f = await inquiryWithDefault("SEK");
    expect(f.rows.map((r) => r.setupPrice)).toEqual(["230.00"]);
  });

  it("GET /inquiries/:id carries supplierCurrency (the supplier's, live)", async () => {
    await eurRate(11.5);
    const eur = await inquiryWithDefault("EUR");
    const sek = await inquiryWithDefault("SEK", ["101", "901"]);
    const app = await purchaseApp();
    const eurRes = await app.inject({ method: "GET", url: `/inquiries/${eur.inquiry.id}` });
    const sekRes = await app.inject({ method: "GET", url: `/inquiries/${sek.inquiry.id}` });
    await app.close();
    expect([eurRes.statusCode, eurRes.json().supplierCurrency]).toEqual([200, "EUR"]);
    expect([sekRes.statusCode, sekRes.json().supplierCurrency]).toEqual([200, "SEK"]);
  });
});

// ---------------------------------------------------------------------------
// 5. Skapa saknade halvfabrikat: the firm balance, and inactive articles
// ---------------------------------------------------------------------------

const overviewRow = (kind: ArticleOverviewRow["kind"], quantity: number): ArticleOverviewRow => ({
  id: `${kind}:${crypto.randomUUID()}`,
  kind,
  direction: quantity < 0 ? "demand" : "supply",
  date: "2030-03-11",
  documentType: kind === "forecast" ? null : "manufacturing_order",
  documentId: null,
  documentNumber: kind,
  status: "released",
  partner: null,
  quantity,
  balance: 0,
  isDraft: false,
});

// Two resources on a 40 h week. P (Ledtid 5 working days, Op 10 on R2) is
// made of one H (Op 10 on R1, 60 min/st), H of one S (the same), S of one
// purchased R — the chain of pegging-missing.test.ts. `forecastSub` makes S
// prognosstyrd.
async function peggingWorld(opts: { forecastSub?: boolean } = {}) {
  const day = await scheduleService.createDaySchedule({ code: "D8", name: "Dagtid 8h", startTime: "07:00", endTime: "15:00", breaks: [], active: true });
  const week = await scheduleService.createWeekSchedule(
    parsed(createWeekScheduleSchema, {
      code: "VS40",
      name: "Veckoschema 40h",
      days: [1, 2, 3, 4, 5].map((weekday) => ({ weekday, dayScheduleId: day.id })),
      active: true,
    })
  );
  const r1 = await plannedMfgService.createWorkCenter(parsed(createWorkCenterSchema, { code: "101", name: "Kap", weekScheduleId: week.id, capacityFactor: 1, active: true }));
  const r2 = await plannedMfgService.createWorkCenter(parsed(createWorkCenterSchema, { code: "201", name: "Montering", weekScheduleId: week.id, capacityFactor: 1, active: true }));
  const raw = await article("R", "purchased");
  const sub = await article("S", "manufactured", opts.forecastSub ? { forecastControlled: true } : {});
  const semi = await article("H", "manufactured");
  const product = await article("P", "manufactured", { manufacturingLeadTimeDays: 5 });
  await plannedMfgService.createRoutingOperation(sub.id, { sequenceNo: 10, workCenterId: r1.id, setupTime: 0, runTimePerUnit: 60 });
  await plannedMfgService.createRoutingOperation(semi.id, { sequenceNo: 10, workCenterId: r1.id, setupTime: 0, runTimePerUnit: 60 });
  await plannedMfgService.createRoutingOperation(product.id, { sequenceNo: 10, workCenterId: r2.id, setupTime: 0, runTimePerUnit: 60 });
  await articleService.addBomComponent(sub.id, { componentArticleId: raw.id, quantity: 1 });
  await articleService.addBomComponent(semi.id, { componentArticleId: sub.id, quantity: 1 });
  await articleService.addBomComponent(product.id, { componentArticleId: semi.id, quantity: 1 });
  return { r1, r2, raw, sub, semi, product };
}

const expectedOf = (preview: { orders: { articleId: string; quantity: number; level: number }[] }) =>
  parsed(missingComponentsSchema, { expected: preview.orders.map((o) => ({ articleId: o.articleId, quantity: o.quantity, level: o.level })) });

describe("5 — Skapa saknade halvfabrikat räknar inte prognos", () => {
  it("firmClosingBalance: stock plus supply minus firm demand — the forecast rows are left out", () => {
    expect(firmClosingBalance({ onHand: 10, rows: [] })).toBe(10);
    expect(
      firmClosingBalance({
        onHand: 10,
        rows: [overviewRow("sales_order", -3), overviewRow("forecast", -40), overviewRow("manufacturing_order", 5), overviewRow("mo_material", -2), overviewRow("forecast", -40)],
      })
    ).toBe(10);
    // Every other kind counts, supply and demand alike.
    expect(
      firmClosingBalance({
        onHand: 0,
        rows: [overviewRow("purchase_order", 4), overviewRow("mo_planned_material", -1), overviewRow("mo_material", -6)],
      })
    ).toBe(-3);
    // Only forecast ⇒ the stock.
    expect(firmClosingBalance({ onHand: 2.5, rows: [overviewRow("forecast", -100)] })).toBe(2.5);
    // Summed in 4-decimal steps like closingBalance: no float noise.
    expect(firmClosingBalance({ onHand: 0.3, rows: [overviewRow("mo_material", -0.1), overviewRow("mo_material", -0.2)] })).toBe(0);
    expect(firmClosingBalance({ onHand: 0, rows: [overviewRow("purchase_order", 0.1), overviewRow("purchase_order", 0.2)] })).toBe(0.3);
  });

  it("a prognosstyrd S with stock is not made for the parent's shortage: a TO for H, none for S", async () => {
    const world = await peggingWorld({ forecastSub: true });
    await stockService.recordTransaction({ articleId: world.sub.id, quantityDelta: 10, transactionType: "inventory_adjustment" });
    // 40 a month of own forecast, this month and the next: far more than the shelf holds.
    await pinnedPlanning.updateArticleForecast(
      world.sub.id,
      parsed(articleForecastUpdateSchema, { months: [{ month: "2030-03", quantity: 40 }, { month: "2030-04", quantity: 40 }] }),
      user.id
    );
    const overview = await pinnedPlanning.getArticleOverview(world.sub.id);
    expect(overview.rows.some((r) => r.kind === "forecast")).toBe(true);
    // The balance Skapa saknade used to net against: the forecast has eaten
    // the shelf, so S's 2 for the new H TO were "missing" and S got a TO of
    // its own. The firm balance still has the 10.
    expect(overview.closingBalance).toBeLessThan(0);
    expect(firmClosingBalance(overview)).toBe(10);

    const parent = await plannedMfgService.createManufacturingOrder({ articleId: world.product.id, quantity: 2, dueDate: "2030-03-29" }, user.id);
    const preview = await pinnedPlanning.getMissingComponents(parent.id);
    expect(preview.orders.map((o) => [o.articleId, o.level, o.quantity])).toEqual([[world.semi.id, 1, 2]]);
    // S is covered by the shelf, so nothing below it is short either.
    expect(preview.notes).toEqual([]);

    const result = await pinnedPlanning.createMissingComponents(parent.id, expectedOf(preview), user.id);
    expect(result.manufacturingOrders.map((mo) => [mo.articleNumber, mo.quantity, mo.level])).toEqual([[world.semi.articleNumber, 2, 1]]);
    expect((await allManufacturingOrders()).some((mo) => mo.articleId === world.sub.id)).toBe(false);
  });

  it("the same S without stock is still made — the forecast neither adds to nor hides the firm shortage", async () => {
    const world = await peggingWorld({ forecastSub: true });
    await pinnedPlanning.updateArticleForecast(world.sub.id, parsed(articleForecastUpdateSchema, { months: [{ month: "2030-04", quantity: 40 }] }), user.id);
    const parent = await plannedMfgService.createManufacturingOrder({ articleId: world.product.id, quantity: 2, dueDate: "2030-03-29" }, user.id);
    const preview = await pinnedPlanning.getMissingComponents(parent.id);
    // 2 — the new H TO's need — not 2 + the forecast.
    expect(preview.orders.map((o) => [o.articleId, o.level, o.quantity])).toEqual([
      [world.semi.id, 1, 2],
      [world.sub.id, 2, 2],
    ]);
  });
});

describe("5 — en inaktiv halvfabrikatsartikel får en notering, ingen TO", () => {
  const missingArticle = (id: string, over: Partial<MissingArticle> = {}): MissingArticle => ({
    articleId: id,
    articleNumber: id.toUpperCase(),
    name: `Artikel ${id}`,
    type: "manufactured",
    unitCode: null,
    orderQuantity: null,
    rounding: null,
    closingBalance: 0,
    active: true,
    configuratorMode: null,
    hasRouting: true,
    ...over,
  });
  const plan = (articles: MissingArticle[]) =>
    planMissingComponents({
      parent: { articleId: "p", articleNumber: "P" },
      today: PINNED_TODAY,
      offDays: new Set(),
      needs: [{ articleId: "h", needDate: "2030-03-22", uncovered: 2 }],
      articles: new Map(articles.map((a) => [a.articleId, a])),
      bomIndex: buildBomIndex([
        { parentArticleId: "h", componentArticleId: "s", quantity: 1 },
        { parentArticleId: "s", componentArticleId: "r", quantity: 1 },
      ]),
      phantomIds: new Set(),
      leadDaysFor: () => 1,
    });

  it("planMissingComponents: an inactive article at level 1 or deeper is a note and its structure is not followed", () => {
    const raw = missingArticle("r", { type: "purchased" });
    const top = plan([missingArticle("h", { active: false }), missingArticle("s"), raw]);
    expect(top.orders).toEqual([]);
    expect(top.notes).toEqual(["H är inaktiv — ingen tillverkningsorder"]);

    const deeper = plan([missingArticle("h"), missingArticle("s", { active: false }), raw]);
    expect(deeper.orders.map((o) => [o.articleId, o.level, o.quantity])).toEqual([["h", 1, 2]]);
    expect(deeper.notes).toEqual(["S är inaktiv — ingen tillverkningsorder"]);
  });

  it("the preview says so and POST makes the TO above it only", async () => {
    const world = await peggingWorld();
    const parent = await plannedMfgService.createManufacturingOrder({ articleId: world.product.id, quantity: 2, dueDate: "2030-03-29" }, user.id);
    // Taken out of use after the structure was built (the article card's Aktiv).
    await db.execute(sql`UPDATE articles SET active = false WHERE id = ${world.sub.id}`);

    const preview = await pinnedPlanning.getMissingComponents(parent.id);
    expect(preview.orders.map((o) => [o.articleId, o.level, o.quantity])).toEqual([[world.semi.id, 1, 2]]);
    expect(preview.notes).toEqual([`${world.sub.articleNumber} är inaktiv — ingen tillverkningsorder`]);

    const result = await pinnedPlanning.createMissingComponents(parent.id, expectedOf(preview), user.id);
    expect(result.manufacturingOrders.map((mo) => mo.articleNumber)).toEqual([world.semi.articleNumber]);
    expect((await allManufacturingOrders()).some((mo) => mo.articleId === world.sub.id)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// 6. The requirements cache is dropped by the routines that change the result
// ---------------------------------------------------------------------------

describe("6 — cachen nollas efter rutinerna som ändrar behovsbilden", () => {
  // A minute's cache — nothing below waits for it to expire, and no read
  // after the routine asks for `refresh`.
  const cached = () => buildPinnedPlanning(60_000);
  const rowOf = async (service: PlanningService, articleId: string) => (await requirements(service)).rows.find((r) => r.articleId === articleId);

  it("the cache is real: a TO made behind the service's back is not seen until refresh", async () => {
    const world = await peggingWorld();
    const service = cached();
    await plannedMfgService.createManufacturingOrder({ articleId: world.product.id, quantity: 2, dueDate: "2030-03-29" }, user.id);
    expect(await rowOf(service, world.semi.id)).toMatchObject({ supplyMo: 0, proposalQuantity: 2 });
    await mfgService.createManufacturingOrder({ articleId: world.semi.id, quantity: 2, dueDate: "2030-03-21" }, user.id);
    expect(await rowOf(service, world.semi.id)).toMatchObject({ supplyMo: 0, proposalQuantity: 2 });
    const fresh = (await requirements(service, { refresh: "true" })).rows.find((r) => r.articleId === world.semi.id);
    expect(fresh).toMatchObject({ supplyMo: 2, proposalQuantity: 0 });
  });

  it("Skapa saknade halvfabrikat: the new TOs are supply in the next read", async () => {
    const world = await peggingWorld();
    const service = cached();
    const parent = await plannedMfgService.createManufacturingOrder({ articleId: world.product.id, quantity: 2, dueDate: "2030-03-29" }, user.id);
    expect(await rowOf(service, world.semi.id)).toMatchObject({ supplyMo: 0, proposalQuantity: 2, proposalKind: "manufacture" });
    expect(await rowOf(service, world.sub.id)).toMatchObject({ supplyMo: 0, proposalQuantity: 2 });

    const preview = await service.getMissingComponents(parent.id);
    const result = await service.createMissingComponents(parent.id, expectedOf(preview), user.id);
    expect(result.manufacturingOrders).toHaveLength(2);

    expect(await rowOf(service, world.semi.id)).toMatchObject({ supplyMo: 2, proposalQuantity: 0, proposals: [] });
    expect(await rowOf(service, world.sub.id)).toMatchObject({ supplyMo: 2, proposalQuantity: 0, proposals: [] });
  });

  it("reservationen (applyDeliveryTime): the reserved TO is supply in the next read", async () => {
    const world = await peggingWorld();
    const service = cached();
    const customer = await makeCustomer();
    // S alone: one manufactured level over a bought R the check does not wait for.
    await db.execute(sql`DELETE FROM bom_components WHERE parent_article_id = ${world.sub.id}`);
    const { order } = await salesService.createQuote({ customerId: customer.id, confirm: true, rows: [{ articleId: world.sub.id, quantity: 3, unitPrice: 100 }] }, user.id);
    expect(await rowOf(service, world.sub.id)).toMatchObject({ demandSales: 3, supplyMo: 0, proposalQuantity: 3 });

    const check = await service.checkDeliveryTime({ salesOrderId: order.id });
    expect(check.deliveryDate).not.toBeNull();
    const applied = await service.applyDeliveryTime({ salesOrderId: order.id, deliveryDate: check.deliveryDate! }, user.id);
    expect(applied.manufacturingOrders.map((mo) => [mo.articleNumber, mo.quantity])).toEqual([[world.sub.articleNumber, 3]]);

    expect(await rowOf(service, world.sub.id)).toMatchObject({ demandSales: 3, supplyMo: 3, proposalQuantity: 0, proposals: [] });
  });

  it("Flytta halvfabrikaten (moveComponentOrders): the moved färdigdatum dates the next read's proposal", async () => {
    const world = await peggingWorld();
    const service = cached();
    const parent = await plannedMfgService.createManufacturingOrder({ articleId: world.product.id, quantity: 2, dueDate: "2030-03-29" }, user.id);
    // H's TO finishes after P starts (Fri 03-22); S is needed when H starts.
    const semi = await mfgService.createManufacturingOrder({ articleId: world.semi.id, quantity: 2, dueDate: "2030-03-27" }, user.id);
    const before = (await rowOf(service, world.sub.id))!;
    expect(before.proposals).toHaveLength(1);

    await service.moveComponentOrders(parent.id, { moves: [{ manufacturingOrderId: semi.id, dueDate: "2030-03-21", expectedDueDate: "2030-03-27" }] }, user.id);

    const after = (await rowOf(service, world.sub.id))!;
    expect(after.proposals).toHaveLength(1);
    // Four working days earlier, like the TO it is material for.
    expect(after.proposals[0]!.needDate).not.toBe(before.proposals[0]!.needDate);
    expect(after.proposals[0]!.needDate! < before.proposals[0]!.needDate!).toBe(true);
    const fresh = (await requirements(service, { refresh: "true" })).rows.find((r) => r.articleId === world.sub.id)!;
    expect(after.proposals).toEqual(fresh.proposals);
  });
});

// ---------------------------------------------------------------------------
// 7. The kind filter of GET /planning/requirements
// ---------------------------------------------------------------------------

describe("7 — filtret kind på GET /planning/requirements", () => {
  it("lego = only the lego operation rows, article = the rest; total follows the filter before paging", async () => {
    // Two lego operations to buy and two article proposals (K and M).
    const articles = await proposalWorld();
    const first = await legoWorld({ codes: ["110", "910"] });
    const second = await legoWorld({ codes: ["111", "911"], legoSupplierId: first.legoSupplier.id });
    const app = await planningApp(planningService);
    const get = async (query: string) => {
      const res = await app.inject({ method: "GET", url: `/planning/requirements?${query}` });
      expect(res.statusCode).toBe(200);
      return res.json() as { rows: { articleId: string; proposalKind: string | null; moOperationId?: string | null }[]; total: number };
    };

    const all = await get("refresh=true&limit=100");
    const legoIds = [first.parent.id, second.parent.id].sort();
    expect(all.total).toBe(4);
    expect(all.rows.filter((r) => r.proposalKind === "subcontract").map((r) => r.articleId).sort()).toEqual(legoIds);

    const lego = await get("kind=lego&limit=100");
    expect(lego.total).toBe(2);
    expect(lego.rows.map((r) => r.proposalKind)).toEqual(["subcontract", "subcontract"]);
    expect(lego.rows.map((r) => r.articleId).sort()).toEqual(legoIds);

    // Paged: one row, but the total is still the filter's — and the second
    // page holds the other lego row, not an article row.
    const page1 = await get("kind=lego&limit=1");
    const page2 = await get("kind=lego&limit=1&offset=1");
    expect([page1.rows.length, page1.total, page2.rows.length, page2.total]).toEqual([1, 2, 1, 2]);
    expect([page1.rows[0]!.articleId, page2.rows[0]!.articleId].sort()).toEqual(legoIds);
    expect((await get("kind=lego&limit=1&offset=2")).rows).toEqual([]);

    const rest = await get("kind=article&limit=100");
    expect(rest.total).toBe(2);
    expect(rest.rows.some((r) => r.proposalKind === "subcontract")).toBe(false);
    expect(rest.rows.map((r) => r.articleId).sort()).toEqual([articles.bought.id, articles.made.id].sort());
    expect((await get("kind=article&limit=1")).total).toBe(2);

    // With Visa alla the parent articles join the article side only.
    const everything = await get("showAll=true&limit=100");
    const legoAll = await get("kind=lego&showAll=true&limit=100");
    const articleAll = await get("kind=article&showAll=true&limit=100");
    expect(legoAll.total).toBe(2);
    expect(legoAll.total + articleAll.total).toBe(everything.total);

    const bad = await app.inject({ method: "GET", url: "/planning/requirements?kind=allt" });
    expect([bad.statusCode, bad.json().code]).toEqual([400, "validation-failed"]);
    await app.close();
  });
});

// ---------------------------------------------------------------------------
// 8. Flytta to a week without capacity
// ---------------------------------------------------------------------------

describe("8 — Flytta till en vecka utan kapacitet", () => {
  const planRows = async (opId: string) =>
    (
      await db
        .select({ monday: moOperationPlanWeeks.weekMonday, minutes: moOperationPlanWeeks.minutes })
        .from(moOperationPlanWeeks)
        .where(eq(moOperationPlanWeeks.moOperationId, opId))
        .orderBy(moOperationPlanWeeks.weekMonday)
    ).map((r) => ({ monday: r.monday, minutes: Number(r.minutes) }));
  const opRow = async (opId: string) => {
    const [row] = await db
      .select({ plannedStartWeek: moOperations.plannedStartWeek, plannedEndWeek: moOperations.plannedEndWeek, planLocked: moOperations.planLocked })
      .from(moOperations)
      .where(eq(moOperations.id, opId));
    return row!;
  };

  it("409 plan-week-no-capacity when every day of the week is a holiday — weeks and lock untouched; a week with capacity is fine and locks", async () => {
    const world = await peggingWorld();
    // Week 12 (W3) closed: Monday–Friday are full-day holidays.
    for (const [i, date] of ["2030-03-18", "2030-03-19", "2030-03-20", "2030-03-21", "2030-03-22"].entries()) {
      await db.execute(sql`INSERT INTO holidays (date, name) VALUES (${date}, ${`Stängt ${i + 1}`})`);
    }
    // 20 h on R1: planned in the current week.
    const order = await plannedMfgService.createManufacturingOrder({ articleId: world.semi.id, quantity: 20, dueDate: "2030-04-30" }, user.id);
    const op = (await plannedMfgService.listOperations(order.id))[0]!;
    expect(await planRows(op.id)).toEqual([{ monday: W1, minutes: 1200 }]);
    expect(await opRow(op.id)).toEqual({ plannedStartWeek: W1, plannedEndWeek: W1, planLocked: false });

    const err = await pinnedPlanning.moveOperation(op.id, { weekMonday: W3, moveFollowing: true }, user.id).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(PlanWeekNoCapacityError);
    expect(err).toMatchObject({ weekMonday: W3, workCenterCode: "101", message: "101 har ingen kapacitet kvar vecka 12 — välj en annan vecka" });

    const app = await planningApp(pinnedPlanning);
    const refused = await app.inject({ method: "POST", url: `/planning/operations/${op.id}/move`, payload: { weekMonday: W3, moveFollowing: true } });
    expect([refused.statusCode, refused.json().code]).toEqual([409, "plan-week-no-capacity"]);
    // Rolled back: the plan is the one it had, and it is not locked.
    expect(await planRows(op.id)).toEqual([{ monday: W1, minutes: 1200 }]);
    expect(await opRow(op.id)).toEqual({ plannedStartWeek: W1, plannedEndWeek: W1, planLocked: false });
    const moves = await db.select({ id: auditLog.id }).from(auditLog).where(eq(auditLog.action, "operation_moved"));
    expect(moves).toEqual([]);

    const moved = await app.inject({ method: "POST", url: `/planning/operations/${op.id}/move`, payload: { weekMonday: W2, moveFollowing: true } });
    expect(moved.statusCode).toBe(200);
    expect(moved.json().operation).toEqual({ plannedStartWeek: W2, plannedEndWeek: W2, planLocked: true });
    expect(await planRows(op.id)).toEqual([{ monday: W2, minutes: 1200 }]);
    await app.close();
  });

  it("a week with one working day left takes what it can — not refused", async () => {
    const world = await peggingWorld();
    // Only the Friday of W3 is open: 8 h of capacity.
    for (const date of ["2030-03-18", "2030-03-19", "2030-03-20", "2030-03-21"]) {
      await db.execute(sql`INSERT INTO holidays (date, name) VALUES (${date}, ${`Stängt ${date}`})`);
    }
    const order = await plannedMfgService.createManufacturingOrder({ articleId: world.semi.id, quantity: 20, dueDate: "2030-04-30" }, user.id);
    const op = (await plannedMfgService.listOperations(order.id))[0]!;

    const moved = await pinnedPlanning.moveOperation(op.id, { weekMonday: W3, moveFollowing: true }, user.id);
    expect(moved.operation).toMatchObject({ plannedStartWeek: W3, planLocked: true });
    expect((await planRows(op.id))[0]).toEqual({ monday: W3, minutes: 480 });
  });
});

// ---------------------------------------------------------------------------
// 9. A partly received TO on a configured (beställningsvara) row
// ---------------------------------------------------------------------------

describe("9 — delinleverans på en konfigurerad rad", () => {
  beforeEach(async () => {
    await resetConfiguredRows();
    await db.execute(CONFIGURED_MFG_TRUNCATE);
    await resetCostingSettings();
  });
  afterAll(async () => {
    await resetConfiguredRows();
    await db.execute(CONFIGURED_MFG_TRUNCATE);
  });

  const configuredPlanning = createPlanningService(createPlanningRepository(db), {
    purchase: configuredPurchaseService,
    manufacturing: configuredMfg,
    configuredStructure: (t, s, q, o) => configurator.deriveForManufacturing(t, s, q, o),
    requirementsCacheMs: 0,
  });
  const configuredRowOf = async (rowId: string) =>
    (await requirements(configuredPlanning, { refresh: "true" })).rows.find((r) => r.proposalKind === "configured" && r.salesOrderRowId === rowId);

  it("row 10, its TO of 6 with 3 received: 4 are still to be made — whether the 3 are delivered or not", async () => {
    const { s, row } = await confirmedRow(10);
    const configuredUser = await makeConfiguredUser();
    expect(await configuredRowOf(row.id)).toMatchObject({ proposalQuantity: 10 });

    // A TO for 6 of the 10 (Skapa ordrar with the user's own quantity).
    const created = await configuredPlanning.createOrdersFromProposals(
      parsed(createPlanningOrdersSchema, { proposals: [{ kind: "configured", articleId: s.article.id, salesOrderRowId: row.id, quantity: 6 }] }),
      configuredUser.id
    );
    expect(created.errors).toEqual([]);
    const moId = created.manufacturingOrders[0]!.id;
    expect(await configuredRowOf(row.id)).toMatchObject({ proposalQuantity: 4 });

    // Delinleverans: 3 OK on the TO's last operation are finished goods,
    // and the TO stays open for the other 3.
    const lastOperation = (await configuredMfg.listOperations(moId)).sort((a, b) => b.sequenceNo - a.sequenceNo)[0]!;
    await configuredMfg.completeOperation(lastOperation.id, parsed(completeOperationSchema, { quantityCompleted: 3 }), configuredUser.id, moId);
    const mo = (await configuredMfg.getManufacturingOrder(moId))!;
    expect([mo.status, Number(mo.quantity), Number(mo.quantityReceived)]).toEqual(["in_progress", 6, 3]);
    // In stock, not delivered: 3 open + 3 finished cover 6.
    expect(await configuredRowOf(row.id)).toMatchObject({ proposalQuantity: 4 });

    // The 3 delivered on the row. The delivery routine itself is not what
    // is under test — the row's delivered quantity is set directly.
    await db.execute(sql`UPDATE sales_order_rows SET quantity_delivered = 3 WHERE id = ${row.id}`);
    // Before the review: 10 − 6 (the whole TO as open) − 3 (delivered) = 1.
    const after = await configuredRowOf(row.id);
    expect(after).toMatchObject({ proposalQuantity: 4 });
    expect(after!.proposals.map((p) => [p.key, p.quantity])).toEqual([[`configured:${row.id}`, 4]]);
  });
});

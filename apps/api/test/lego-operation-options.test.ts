import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import { db } from "@navet/db";
import { testArticleService, testDocumentPdfService } from "./helpers/services.js";
import { createArticleRepository } from "../src/modules/article/repository/article.repository.js";
import { createArticleService } from "../src/modules/article/service/article.service.js";
import { createAuthRepository } from "../src/modules/auth/repository/auth.repository.js";
import { createManufacturingRepository } from "../src/modules/manufacturing/repository/manufacturing.repository.js";
import { createManufacturingService } from "../src/modules/manufacturing/service/manufacturing.service.js";
import { createPurchaseRepository } from "../src/modules/purchase/repository/purchase.repository.js";
import { createSalesRepository } from "../src/modules/sales/repository/sales.repository.js";
import { markSalesOrderInProduction } from "../src/modules/sales/service/production-transition.js";
import { insertPlannedManufacturingOrder } from "./helpers/planned-manufacturing-order.js";

// GET /articles/:id/lego-operations — feeds the inquiry row form's
// "Legooperation" select with the article's own lego routing operations
// followed by open TO lego operations for the same article. Fixture style
// copied from inquiry-lego.test.ts (makeLegoRouting/releasedMo), trimmed to
// only the collaborators this endpoint actually needs.

const articleService = createArticleService(createArticleRepository(db));
const authRepo = createAuthRepository(db);
const salesRepository = createSalesRepository(db);
const purchaseRepository = createPurchaseRepository(db);
const mfgService = createManufacturingService(createManufacturingRepository(db), testDocumentPdfService, testArticleService, {
  findRowForManufacturing: salesRepository.findRowForManufacturing,
  lockRowForManufacturing: salesRepository.lockRowForManufacturing,
  markInProduction: markSalesOrderInProduction,
});

const TABLES = sql`TRUNCATE mo_operation_scrap, mo_material_consumptions, mo_operations, manufacturing_orders, routing_operations, work_centers, production_groups, suppliers, stock_transactions, stock_locations, warehouses, bom_components, articles, audit_log, users CASCADE`;

beforeEach(async () => {
  await db.execute(TABLES);
});

afterAll(async () => {
  await db.execute(TABLES);
});

async function makeUser() {
  return authRepo.create({
    email: `lego-opts-${crypto.randomUUID()}@example.com`,
    passwordHash: "not-a-real-hash",
    name: "Beredare",
    role: "admin",
  });
}

async function makeSupplier(name = "Lego AB") {
  return purchaseRepository.createSupplier({ name, active: true });
}

// Manufactured article with one machine operation (10) and one lego
// operation (20, ställpris 500 / styckpris 100) — same shape as
// inquiry-lego.test.ts's makeLegoRouting.
async function makeLegoRouting() {
  const user = await makeUser();
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
    articleNumber: `LEGO-${crypto.randomUUID()}`,
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

  return { user, supplier, machine, lego, parent, machineOp, routingLegoOp };
}

async function releasedMo(quantity = 4) {
  const fixture = await makeLegoRouting();
  const order = await mfgService.createManufacturingOrder({ articleId: fixture.parent.id, quantity }, fixture.user.id);
  const operations = await mfgService.listOperations(order.id);
  const moLegoOp = operations.find((op) => op.sequenceNo === 20)!;
  return { ...fixture, order, moLegoOp };
}

describe("GET /articles/:id/lego-operations", () => {
  it("lists the routing lego op, not the machine op", async () => {
    const f = await makeLegoRouting();
    const options = await mfgService.listLegoOperationOptions(f.parent.id);
    expect(options).toHaveLength(1);
    expect(options[0]).toMatchObject({
      key: `routing:${f.routingLegoOp.id}`,
      kind: "routing",
      routingOperationId: f.routingLegoOp.id,
      moOperationId: null,
      label: "Op 20 · Ytbehandling (beredning)",
      supplierId: f.supplier.id,
      setupPrice: "500.00",
      unitPrice: "100.0000",
    });
  });

  it("lists a released MO's pending lego op after the routing entry", async () => {
    const f = await releasedMo();
    const options = await mfgService.listLegoOperationOptions(f.parent.id);
    expect(options).toHaveLength(2);
    expect(options[0]!.kind).toBe("routing");
    expect(options[1]).toMatchObject({
      key: `mo:${f.moLegoOp.id}`,
      kind: "mo",
      routingOperationId: f.routingLegoOp.id,
      moOperationId: f.moLegoOp.id,
      label: `${f.order.orderNumber} · Op 20 · Ytbehandling`,
      supplierId: f.supplier.id,
      setupPrice: "500.00",
      unitPrice: "100.0000",
    });
  });

  it("excludes a planned (unreleased) MO's operation and one already reported done", async () => {
    const f = await makeLegoRouting();
    // An older order still in planned — it has no operations to surface.
    await insertPlannedManufacturingOrder({ articleId: f.parent.id, quantity: 3, createdBy: f.user.id });
    expect((await mfgService.listLegoOperationOptions(f.parent.id)).map((o) => o.kind)).toEqual(["routing"]);

    const order = await mfgService.createManufacturingOrder({ articleId: f.parent.id, quantity: 2 }, f.user.id);
    const moLegoOp = (await mfgService.listOperations(order.id)).find((op) => op.sequenceNo === 20)!;

    let options = await mfgService.listLegoOperationOptions(f.parent.id);
    expect(options.filter((o) => o.kind === "mo")).toHaveLength(1);
    expect(options.find((o) => o.kind === "mo")!.moOperationId).toBe(moLegoOp.id);

    await mfgService.reportOperationQuantities(moLegoOp.id, {
      quantityOk: 2,
      quantityScrapped: 0,
      markDone: true,
      createdBy: f.user.id,
    });
    options = await mfgService.listLegoOperationOptions(f.parent.id);
    // Both the planned MO and the now-done operation stay out — only the
    // article's routing entry remains.
    expect(options.map((o) => o.kind)).toEqual(["routing"]);
  });

  it("returns [] for an article without lego operations", async () => {
    const plain = await articleService.createArticle({
      articleNumber: `PLAIN-${crypto.randomUUID()}`,
      name: "Vanlig",
      type: "manufactured",
      unit: "st",
      active: true,
    });
    expect(await mfgService.listLegoOperationOptions(plain.id)).toEqual([]);
  });
});

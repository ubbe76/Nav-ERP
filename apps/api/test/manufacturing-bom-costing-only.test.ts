import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { and, eq, sql } from "drizzle-orm";
import { bomComponents, db, stockTransactions } from "@navet/db";
import { createArticleSchema, type CreateArticleInput } from "@navet/shared";
import { testArticleService, testDocumentPdfService } from "./helpers/services.js";
import { createArticleRepository } from "../src/modules/article/repository/article.repository.js";
import { CostingOnlyOperationLinkError, createArticleService } from "../src/modules/article/service/article.service.js";
import { createAuthRepository } from "../src/modules/auth/repository/auth.repository.js";
import { createManufacturingRepository } from "../src/modules/manufacturing/repository/manufacturing.repository.js";
import { createManufacturingService, OperationHasLinkedMaterialError } from "../src/modules/manufacturing/service/manufacturing.service.js";
import { createStockRepository } from "../src/modules/stock/repository/stock.repository.js";
import { createStockService } from "../src/modules/stock/service/stock.service.js";

// "Kalkyl" on a structure row (bom_components.costing_only, Monitor's
// "End. kal."): the row is priced in the förkalkyl like any other but never
// reaches a manufacturing order — no material line, no withdrawal on report
// or final completion, no shortage warning. The material twin of the Kalkyl
// operation; see manufacturing.md.

const articleService = createArticleService(createArticleRepository(db));
const stockService = createStockService(createStockRepository(db));
const authRepo = createAuthRepository(db);
const mfgService = createManufacturingService(createManufacturingRepository(db), testDocumentPdfService, testArticleService);

const TRUNCATE = sql`TRUNCATE mo_report_materials, mo_reports, mo_material_consumptions, mo_operations, manufacturing_orders, routing_operations, work_centers, stock_transactions, stock_locations, warehouses, bom_components, articles, users CASCADE`;

beforeEach(async () => {
  await db.execute(TRUNCATE);
});
afterAll(async () => {
  await db.execute(TRUNCATE);
});

async function makeUser() {
  return authRepo.create({
    email: `kalkylrad-${crypto.randomUUID()}@example.com`,
    passwordHash: "not-a-real-hash",
    name: "Producer",
    role: "admin",
  });
}

async function makeArticle(name: string, extra: Partial<CreateArticleInput> = {}) {
  return articleService.createArticle(
    createArticleSchema.parse({
      articleNumber: `${name}-${crypto.randomUUID().slice(0, 8)}`,
      name,
      type: "purchased",
      unit: "st",
      active: true,
      ...extra,
    }) as CreateArticleInput
  );
}

async function makeLocation() {
  const warehouse = await stockService.createWarehouse({ name: "Huvudlager", active: true });
  return stockService.createLocation({ warehouseId: warehouse.id, name: "A1", active: true });
}

async function seedStock(articleId: string, locationId: string, quantity: number) {
  await stockService.recordTransaction({ articleId, locationId, quantityDelta: quantity, transactionType: "inventory_adjustment" });
}

async function withdrawalsOf(articleId: string) {
  return db
    .select()
    .from(stockTransactions)
    .where(and(eq(stockTransactions.articleId, articleId), eq(stockTransactions.transactionType, "mo_consumption")));
}

// A parent with an ordinary component (2/st) and a Kalkyl component (3/st).
async function parentWithKalkylRow() {
  const parent = await makeArticle("Parent", { type: "manufactured" });
  const ordinary = await makeArticle("Ordinary");
  const kalkyl = await makeArticle("Kalkyl");
  await articleService.addBomComponent(parent.id, { componentArticleId: ordinary.id, quantity: 2 });
  const kalkylRow = await articleService.addBomComponent(parent.id, { componentArticleId: kalkyl.id, quantity: 3, costingOnly: true });
  return { parent, ordinary, kalkyl, kalkylRow };
}

describe("Kalkyl structure row — the article card's API", () => {
  it("stores the flag, returns it on every BOM read and lets it be toggled", async () => {
    const { parent, kalkylRow, ordinary } = await parentWithKalkylRow();
    expect(kalkylRow.costingOnly).toBe(true);

    const bom = await articleService.getBom(parent.id);
    expect(bom.map((r) => [r.componentArticleId, r.costingOnly])).toEqual([
      [ordinary.id, false],
      [kalkylRow.componentArticleId, true],
    ]);

    const cleared = await articleService.updateBomComponent(parent.id, kalkylRow.id, { costingOnly: false });
    expect(cleared.costingOnly).toBe(false);
    const flagged = await articleService.updateBomComponent(parent.id, kalkylRow.id, { costingOnly: true });
    expect(flagged.costingOnly).toBe(true);
  });

  it("lets a Kalkyl row link to a Kalkyl operation, but not an ordinary row — and un-flagging re-checks the link", async () => {
    const parent = await makeArticle("Parent", { type: "manufactured" });
    const material = await makeArticle("Material");
    const wc = await mfgService.createWorkCenter({ code: "100", name: "Svets", active: true });
    const calcOp = await mfgService.createRoutingOperation(parent.id, {
      sequenceNo: 10, workCenterId: wc.id, setupTime: 1, runTimePerUnit: 1, costingOnly: true,
    });

    // An ordinary row on a Kalkyl operation would fall through to final
    // reporting unnoticed — refused as before.
    await expect(
      articleService.addBomComponent(parent.id, { componentArticleId: material.id, quantity: 1, routingOperationId: calcOp.id })
    ).rejects.toBeInstanceOf(CostingOnlyOperationLinkError);

    // A Kalkyl row never reaches the TO, so its link is harmless.
    const row = await articleService.addBomComponent(parent.id, {
      componentArticleId: material.id, quantity: 1, routingOperationId: calcOp.id, costingOnly: true,
    });
    expect(row.routingOperationId).toBe(calcOp.id);

    // Losing the flag while keeping the link is the refused combination again.
    await expect(articleService.updateBomComponent(parent.id, row.id, { costingOnly: false })).rejects.toBeInstanceOf(
      CostingOnlyOperationLinkError
    );
    // Dropping the link and the flag together is fine.
    const plain = await articleService.updateBomComponent(parent.id, row.id, { costingOnly: false, routingOperationId: null });
    expect([plain.costingOnly, plain.routingOperationId]).toEqual([false, null]);
  });

  it("does not let a Kalkyl row block marking its operation Kalkyl, while an ordinary row still does", async () => {
    const parent = await makeArticle("Parent", { type: "manufactured" });
    const a = await makeArticle("A");
    const b = await makeArticle("B");
    const wc = await mfgService.createWorkCenter({ code: "100", name: "Svets", active: true });
    const op = await mfgService.createRoutingOperation(parent.id, { sequenceNo: 10, workCenterId: wc.id, setupTime: 1, runTimePerUnit: 1 });
    await articleService.addBomComponent(parent.id, { componentArticleId: a.id, quantity: 1, routingOperationId: op.id, costingOnly: true });
    const ordinary = await articleService.addBomComponent(parent.id, { componentArticleId: b.id, quantity: 1, routingOperationId: op.id });

    await expect(mfgService.updateRoutingOperation(parent.id, op.id, { costingOnly: true })).rejects.toBeInstanceOf(
      OperationHasLinkedMaterialError
    );
    await articleService.updateBomComponent(parent.id, ordinary.id, { routingOperationId: null });
    const flagged = await mfgService.updateRoutingOperation(parent.id, op.id, { costingOnly: true });
    expect(flagged.costingOnly).toBe(true);
  });

  it("Kopiera beredning carries the flag", async () => {
    const { parent, kalkyl, ordinary } = await parentWithKalkylRow();
    const copy = await makeArticle("Copy", { type: "manufactured", copyFrom: { articleId: parent.id, parts: ["beredning"] } });
    const rows = await db.select().from(bomComponents).where(eq(bomComponents.parentArticleId, copy.id));
    expect(rows.map((r) => [r.componentArticleId, r.costingOnly]).sort()).toEqual(
      [
        [ordinary.id, false],
        [kalkyl.id, true],
      ].sort()
    );
  });
});

describe("Kalkyl structure row — release and reporting", () => {
  it("is not snapshotted onto the TO: no material line, no shortage warning, no withdrawal on report or completion", async () => {
    const user = await makeUser();
    const { parent, ordinary, kalkyl } = await parentWithKalkylRow();
    const location = await makeLocation();
    await seedStock(ordinary.id, location.id, 100);
    // Deliberately NO stock for the Kalkyl component: it must not warn either.
    const wc = await mfgService.createWorkCenter({ code: "100", name: "Svets", active: true });
    await mfgService.createRoutingOperation(parent.id, { sequenceNo: 10, workCenterId: wc.id, setupTime: 1, runTimePerUnit: 1 });

    const order = await mfgService.createManufacturingOrder({ articleId: parent.id, quantity: 5 }, user.id);
    expect(order.status).toBe("released");
    expect(order.releaseWarnings).toEqual([]);
    const materials = await mfgService.listMaterialConsumptions(order.id);
    expect(materials.map((m) => [m.componentArticleId, m.quantityPlanned])).toEqual([[ordinary.id, "10.0000"]]);

    // Report 3 OK on the (last) operation — a delinleverans that draws the
    // ordinary component for 3 — then complete the remaining 2. Neither path
    // touches the Kalkyl component.
    const [operation] = await mfgService.listOperations(order.id);
    await mfgService.completeOperation(operation!.id, { quantityCompleted: 3, quantityScrapped: 0 }, user.id);
    await mfgService.complete(order.id, { locationId: location.id }, user.id);

    expect((await withdrawalsOf(ordinary.id)).reduce((sum, t) => sum + Number(t.quantityDelta), 0)).toBe(-10);
    expect(await withdrawalsOf(kalkyl.id)).toEqual([]);
    expect(await mfgService.listMaterialConsumptions(order.id)).toHaveLength(1);
  });

  it("drops the whole subtree under a Kalkyl phantom, while an ordinary phantom is still exploded", async () => {
    const user = await makeUser();
    const parent = await makeArticle("Parent", { type: "manufactured" });
    const kalkylPhantom = await makeArticle("KalkylFantom", { type: "manufactured", isPhantom: true });
    const plainPhantom = await makeArticle("Fantom", { type: "manufactured", isPhantom: true });
    const underKalkyl = await makeArticle("UnderKalkyl");
    const underPlain = await makeArticle("UnderPlain");
    await articleService.addBomComponent(kalkylPhantom.id, { componentArticleId: underKalkyl.id, quantity: 4 });
    await articleService.addBomComponent(plainPhantom.id, { componentArticleId: underPlain.id, quantity: 3 });
    await articleService.addBomComponent(parent.id, { componentArticleId: kalkylPhantom.id, quantity: 2, costingOnly: true });
    await articleService.addBomComponent(parent.id, { componentArticleId: plainPhantom.id, quantity: 2 });

    const order = await mfgService.createManufacturingOrder({ articleId: parent.id, quantity: 5 }, user.id);
    const materials = await mfgService.listMaterialConsumptions(order.id);
    expect(materials.map((m) => [m.componentArticleId, m.quantityPlanned])).toEqual([[underPlain.id, "30.0000"]]);
  });

  it("counts only the ordinary row when the same component sits on an ordinary and a Kalkyl row", async () => {
    const user = await makeUser();
    const parent = await makeArticle("Parent", { type: "manufactured" });
    const material = await makeArticle("Material");
    await articleService.addBomComponent(parent.id, { componentArticleId: material.id, quantity: 2, position: "1" });
    await articleService.addBomComponent(parent.id, { componentArticleId: material.id, quantity: 7, position: "2", costingOnly: true });

    const order = await mfgService.createManufacturingOrder({ articleId: parent.id, quantity: 5 }, user.id);
    const materials = await mfgService.listMaterialConsumptions(order.id);
    expect(materials.map((m) => [m.componentArticleId, m.quantityPlanned])).toEqual([[material.id, "10.0000"]]);
  });

  it("releases an order with no material at all when every row is Kalkyl", async () => {
    const user = await makeUser();
    const parent = await makeArticle("Parent", { type: "manufactured" });
    const kalkyl = await makeArticle("Kalkyl");
    await articleService.addBomComponent(parent.id, { componentArticleId: kalkyl.id, quantity: 1, costingOnly: true });

    const order = await mfgService.createManufacturingOrder({ articleId: parent.id, quantity: 5 }, user.id);
    expect(order.status).toBe("released");
    expect(order.releaseWarnings).toEqual([]);
    expect(await mfgService.listMaterialConsumptions(order.id)).toEqual([]);
  });
});

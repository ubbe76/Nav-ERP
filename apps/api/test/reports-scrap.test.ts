import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import { db } from "@navet/db";
import { testArticleService, testDocumentPdfService } from "./helpers/services.js";
import { createArticleRepository } from "../src/modules/article/repository/article.repository.js";
import { createArticleService } from "../src/modules/article/service/article.service.js";
import { createAuthRepository } from "../src/modules/auth/repository/auth.repository.js";
import { createManufacturingRepository } from "../src/modules/manufacturing/repository/manufacturing.repository.js";
import { createManufacturingService } from "../src/modules/manufacturing/service/manufacturing.service.js";
import { createSalesRepository } from "../src/modules/sales/repository/sales.repository.js";
import { markSalesOrderInProduction } from "../src/modules/sales/service/production-transition.js";
import { createReportsRepository } from "../src/modules/reports/repository/reports.repository.js";
import { createReportsService } from "../src/modules/reports/service/reports.service.js";

const articleService = createArticleService(createArticleRepository(db));
const authRepo = createAuthRepository(db);
const salesRepository = createSalesRepository(db);
const mfgService = createManufacturingService(createManufacturingRepository(db), testDocumentPdfService, testArticleService, {
  findRowForManufacturing: salesRepository.findRowForManufacturing,
  lockRowForManufacturing: salesRepository.lockRowForManufacturing,
  markInProduction: markSalesOrderInProduction,
});
const reportsService = createReportsService(createReportsRepository(db));

const TRUNCATE = sql`TRUNCATE mo_material_consumptions, mo_operation_scrap, mo_operations, manufacturing_orders, routing_operations, work_centers, production_groups, stock_transactions, stock_locations, warehouses, bom_components, articles, users CASCADE`;

beforeEach(async () => {
  await db.execute(TRUNCATE);
});

afterAll(async () => {
  await db.execute(TRUNCATE);
});

async function makeUser() {
  return authRepo.create({
    email: `rep-scrap-${crypto.randomUUID()}@example.com`,
    passwordHash: "not-a-real-hash",
    name: "Reporter",
    role: "admin",
  });
}

// One parent article with a single routing operation on its own work center,
// released as an MO — the minimal setup reportOperationQuantities needs (no
// BOM/material required for the scrap statistics themselves).
async function makeReleasedOperation(articleName: string, workCenterName: string, moQuantity = 10) {
  const user = await makeUser();
  const parent = await articleService.createArticle({
    articleNumber: `PARENT-SCRAP-${crypto.randomUUID()}`,
    name: articleName,
    type: "manufactured",
    unit: "st",
    active: true,
  });
  const workCenter = await mfgService.createWorkCenter({
    code: String(Math.floor(Math.random() * 900) + 100),
    name: workCenterName,
    active: true,
  });
  await mfgService.createRoutingOperation(parent.id, {
    sequenceNo: 10,
    workCenterId: workCenter.id,
    setupTime: 1,
    runTimePerUnit: 0.5,
  });
  const order = await mfgService.createManufacturingOrder({ articleId: parent.id, quantity: moQuantity }, user.id);
  const operations = await mfgService.listOperations(order.id);
  return { user, parent, workCenter, order, operation: operations[0]! };
}

const currentMonth = () => new Date().toLocaleDateString("sv-SE").slice(0, 7);

describe("reports service — scrap statistics", () => {
  it("groups by exact reason string — 'Spån' and 'spån' stay separate rows", async () => {
    const a = await makeReleasedOperation("Artikel A", "Svets A");
    const b = await makeReleasedOperation("Artikel B", "Svets B");

    await mfgService.reportOperationQuantities(a.operation.id, {
      quantityOk: 6,
      quantityScrapped: 3,
      scrapReason: "Spån",
      markDone: true,
      createdBy: a.user.id,
    });
    await mfgService.reportOperationQuantities(b.operation.id, {
      quantityOk: 8,
      quantityScrapped: 2,
      scrapReason: "spån",
      markDone: true,
      createdBy: b.user.id,
    });

    const result = await reportsService.getScrapStatistics({ groupBy: "reason" });

    expect(result.rows).toHaveLength(2);
    // Sorted by scrappedQuantity descending.
    // Kvalitet (0153): free-text rows (no Avvikelseorsak) are labelled
    // "(fritext)" and keyed apart from the register's reason ids.
    expect(result.rows[0]!.key).toBe("text:Spån");
    expect(result.rows[0]!.label).toBe("Spån (fritext)");
    expect(result.rows[0]!.scrappedQuantity).toBe(3);
    expect(result.rows[0]!.reportCount).toBe(1);
    expect(result.rows[1]!.key).toBe("text:spån");
    expect(result.rows[1]!.scrappedQuantity).toBe(2);
    expect(result.totalScrapped).toBe(5);
  });

  it("groups by article and by work center", async () => {
    const a = await makeReleasedOperation("Artikel A", "Svets A");
    const b = await makeReleasedOperation("Artikel B", "Svets B");

    await mfgService.reportOperationQuantities(a.operation.id, {
      quantityOk: 6,
      quantityScrapped: 3,
      scrapReason: "Repor",
      markDone: true,
      createdBy: a.user.id,
    });
    await mfgService.reportOperationQuantities(b.operation.id, {
      quantityOk: 8,
      quantityScrapped: 2,
      scrapReason: "Måttfel",
      markDone: true,
      createdBy: b.user.id,
    });

    const byArticle = await reportsService.getScrapStatistics({ groupBy: "article" });
    expect(byArticle.rows).toHaveLength(2);
    const rowA = byArticle.rows.find((r) => r.key === a.parent.id)!;
    expect(rowA.label).toBe(`${a.parent.articleNumber} — ${a.parent.name}`);
    expect(rowA.scrappedQuantity).toBe(3);
    const rowB = byArticle.rows.find((r) => r.key === b.parent.id)!;
    expect(rowB.scrappedQuantity).toBe(2);

    const byWorkCenter = await reportsService.getScrapStatistics({ groupBy: "workCenter" });
    expect(byWorkCenter.rows).toHaveLength(2);
    const wcA = byWorkCenter.rows.find((r) => r.key === a.workCenter.id)!;
    expect(wcA.label).toBe("Svets A");
    expect(wcA.scrappedQuantity).toBe(3);
    const wcB = byWorkCenter.rows.find((r) => r.key === b.workCenter.id)!;
    expect(wcB.label).toBe("Svets B");
    expect(wcB.scrappedQuantity).toBe(2);
  });

  it("buckets by month (Stockholm wall clock)", async () => {
    const a = await makeReleasedOperation("Artikel A", "Svets A");
    await mfgService.reportOperationQuantities(a.operation.id, {
      quantityOk: 9,
      quantityScrapped: 1,
      scrapReason: "Test",
      markDone: true,
      createdBy: a.user.id,
    });

    const result = await reportsService.getScrapStatistics({ groupBy: "month" });
    expect(result.rows).toHaveLength(1);
    expect(result.rows[0]!.key).toBe(currentMonth());
    expect(result.rows[0]!.label).toBe(currentMonth());
    expect(result.rows[0]!.scrappedQuantity).toBe(1);
    expect(result.rows[0]!.reportCount).toBe(1);
  });
});

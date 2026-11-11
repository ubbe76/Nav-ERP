import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { asc, desc, eq, sql } from "drizzle-orm";
import type { z } from "zod";
import {
  articleStandardCostHistory,
  articles,
  bomComponents,
  db,
  moMaterialConsumptions,
  moOperations,
  numberSeries,
  stockTransactions,
  units,
  type Tx,
} from "@navet/db";
import {
  createArticleSchema,
  createRoutingOperationSchema,
  createStockLocationSchema,
  createWorkCenterSchema,
  gtinForms,
  gtinKey,
} from "@navet/shared";
import { buildApp } from "../src/app.js";
import { createArticleRepository, recordStandardCostHistory } from "../src/modules/article/repository/article.repository.js";
import { BOM_STRUCTURE_LOCK_SQL } from "../src/modules/article/repository/bom-write.js";
import { explodeBom } from "../src/modules/article/service/bom-explosion.js";
import {
  ArticleHasStockError,
  ArticleRevisionNotFoundError,
  BomCycleError,
  createArticleService,
  DuplicateArticleBarcodeError,
  InvalidReferenceError,
} from "../src/modules/article/service/article.service.js";
import { createAuthRepository } from "../src/modules/auth/repository/auth.repository.js";
import { createImportRepository } from "../src/modules/import/repository/import.repository.js";
import { createImportService } from "../src/modules/import/service/import.service.js";
import { createManufacturingRepository } from "../src/modules/manufacturing/repository/manufacturing.repository.js";
import { createManufacturingService } from "../src/modules/manufacturing/service/manufacturing.service.js";
import { createScanRepository } from "../src/modules/scan/repository/scan.repository.js";
import { createScanService } from "../src/modules/scan/service/scan.service.js";
import { createStockRepository } from "../src/modules/stock/repository/stock.repository.js";
import { StockLocationNotFoundError } from "../src/modules/stock/service/stock.errors.js";
import { createStockService } from "../src/modules/stock/service/stock.service.js";
import { isStockedArticle } from "../src/modules/stock/service/stocked-article.js";
import { parsed } from "./helpers/parsed.js";
import { testDocumentPdfService } from "./helpers/services.js";
import { unwiredSalesOrderLinks } from "./helpers/unwired.js";
import { waitForLockWaiter } from "./helpers/year-end.js";

// Artikelgranskningen 2026-11-11: the article module, the register's units
// and the scan — one block per finding (article.md, stock.md, scan.md,
// manufacturing.md).

const articleRepo = createArticleRepository(db);
const articleService = createArticleService(articleRepo);
const stockService = createStockService(createStockRepository(db));
const mfg = createManufacturingService(createManufacturingRepository(db), testDocumentPdfService, articleService, unwiredSalesOrderLinks);
const authRepo = createAuthRepository(db);
const importRepo = createImportRepository(db);
const importService = createImportService(importRepo);
const scanService = createScanService(createScanRepository(db));

const TRUNCATE = sql`TRUNCATE routing_operation_article_files, routing_operation_drawings, mo_drawing_revisions, mo_report_materials, mo_reports, mo_material_consumptions, mo_operations, manufacturing_orders, routing_operations, work_centers, stock_transactions, stock_locations, warehouses, article_files, article_drawing_revisions, article_drawings, article_revisions, article_standard_cost_history, bom_components, articles, audit_log, users CASCADE`;

beforeEach(async () => {
  await db.execute(TRUNCATE);
});
afterAll(async () => {
  await db.execute(TRUNCATE);
});

const short = () => crypto.randomUUID().slice(0, 8);

async function makeArticle(name: string, extra: Partial<z.input<typeof createArticleSchema>> = {}) {
  return articleService.createArticle(
    parsed(createArticleSchema, { articleNumber: `${name}-${short()}`, name, type: "purchased", active: true, ...extra })
  );
}

async function makeUser() {
  return authRepo.create({ email: `ag-${crypto.randomUUID()}@example.com`, passwordHash: "not-a-real-hash", name: "Granskare", role: "admin" });
}

async function makeWorkCenter(code = "100") {
  return mfg.createWorkCenter(parsed(createWorkCenterSchema, { code, name: `Resurs ${code}`, active: true }));
}

async function makeOperation(articleId: string, workCenterId: string, sequenceNo: number, extra: { costingOnly?: boolean } = {}) {
  return mfg.createRoutingOperation(
    articleId,
    parsed(createRoutingOperationSchema, { sequenceNo, workCenterId, setupTime: 1, runTimePerUnit: 1, ...extra })
  );
}

async function makeLocation(name: string, extra: { blocked?: boolean } = {}) {
  const warehouse = await stockService.createWarehouse({ name: `Lager ${short()}`, active: true });
  return stockService.createLocation(parsed(createStockLocationSchema, { warehouseId: warehouse!.id, name, active: true, ...extra }));
}

async function adjustStock(articleId: string, locationId: string, quantityDelta: number) {
  await stockService.recordTransaction({ articleId, locationId, quantityDelta, transactionType: "inventory_adjustment" });
}

async function materialLines(moId: string) {
  return db
    .select({
      componentArticleId: moMaterialConsumptions.componentArticleId,
      quantityPlanned: moMaterialConsumptions.quantityPlanned,
      sequenceNo: moOperations.sequenceNo,
    })
    .from(moMaterialConsumptions)
    .leftJoin(moOperations, eq(moOperations.id, moMaterialConsumptions.moOperationId))
    .where(eq(moMaterialConsumptions.manufacturingOrderId, moId))
    .orderBy(asc(moMaterialConsumptions.quantityPlanned));
}

// A transaction that does `work`, then stays open until released — the
// other side of a race, held at a known point.
function heldTransaction(work: (tx: Tx) => Promise<void>) {
  let begun!: () => void;
  const ready = new Promise<void>((resolve) => (begun = resolve));
  let release!: () => void;
  const mayCommit = new Promise<void>((resolve) => (release = resolve));
  const done = db.transaction(async (tx) => {
    await work(tx);
    begun();
    await mayCommit;
  });
  return { ready, release, done };
}

// Starts `contender` while `held` is open, waits until something waits on a
// lock, then lets `held` commit — always, so a missing lock (the test failing)
// never leaves the held transaction blocking the next test's clean-up. The
// contender's outcome: its value, or what it threw.
async function raceAgainst(held: ReturnType<typeof heldTransaction>, contender: () => Promise<unknown>): Promise<unknown> {
  await held.ready;
  let outcome!: Promise<unknown>;
  try {
    outcome = contender().then(
      (value) => value,
      (err: unknown) => err
    );
    await waitForLockWaiter();
  } finally {
    held.release();
    await held.done;
  }
  return outcome;
}

describe("fantomens egna operationskopplingar (länkregeln)", () => {
  it("releases a TO whose phantom part is linked to the phantom's own operation and also sits unlinked on the parent", async () => {
    const user = await makeUser();
    const wc = await makeWorkCenter();
    const parent = await makeArticle("P", { type: "manufactured" });
    const phantom = await makeArticle("F", { type: "manufactured", isPhantom: true });
    const part = await makeArticle("C");
    const phantomOp = await makeOperation(phantom.id, wc.id, 10);
    await articleService.addBomComponent(phantom.id, { componentArticleId: part.id, quantity: 3, routingOperationId: phantomOp.id });
    await articleService.addBomComponent(parent.id, { componentArticleId: phantom.id, quantity: 2 });
    await articleService.addBomComponent(parent.id, { componentArticleId: part.id, quantity: 1 });

    // Before: the part's line on the phantom's operation became unlinked at
    // release next to the unlinked line — mo_material_unique_per_operation, 500.
    const order = await mfg.createManufacturingOrder({ articleId: parent.id, quantity: 5 }, user.id);
    expect(await materialLines(order.id)).toEqual([{ componentArticleId: part.id, quantityPlanned: "35.0000", sequenceNo: null }]);
  });

  it("lets the phantom row's link win over the phantom's own link", async () => {
    const user = await makeUser();
    const wc = await makeWorkCenter();
    const parent = await makeArticle("P", { type: "manufactured" });
    const phantom = await makeArticle("F", { type: "manufactured", isPhantom: true });
    const part = await makeArticle("C");
    const parentOp = await makeOperation(parent.id, wc.id, 10);
    await makeOperation(parent.id, wc.id, 20);
    const phantomOp = await makeOperation(phantom.id, wc.id, 20);
    await articleService.addBomComponent(phantom.id, { componentArticleId: part.id, quantity: 3, routingOperationId: phantomOp.id });
    await articleService.addBomComponent(parent.id, { componentArticleId: phantom.id, quantity: 2, routingOperationId: parentOp.id });

    const order = await mfg.createManufacturingOrder({ articleId: parent.id, quantity: 5 }, user.id);
    // Drawn at the parent's operation 10 (where the phantom goes in), not
    // unlinked (the phantom's operation is not on this TO).
    expect(await materialLines(order.id)).toEqual([{ componentArticleId: part.id, quantityPlanned: "30.0000", sequenceNo: 10 }]);

    // The same rule in every explosion: in the förkalkyl's mode too, and a
    // phantom exploded as the root (the configurator's and the costing
    // preview's phantom material) gives unlinked parts — the caller applies
    // its phantom row's link.
    for (const mode of ["include", "exclude"] as const) {
      expect((await explodeBom(db, parent.id, 1, mode)).map((c) => c.routingOperationId)).toEqual([parentOp.id]);
      expect((await explodeBom(db, phantom.id, 1, mode)).map((c) => c.routingOperationId)).toEqual([null]);
    }
  });

  it("merges two lines that land on the same TO operation at release (a link the TO does not have)", async () => {
    const user = await makeUser();
    const wc = await makeWorkCenter();
    const parent = await makeArticle("P", { type: "manufactured" });
    const part = await makeArticle("C");
    const kalkylOp = await makeOperation(parent.id, wc.id, 10, { costingOnly: true });
    await articleService.addBomComponent(parent.id, { componentArticleId: part.id, quantity: 1 });
    // An ordinary row on a Kalkyl operation — refused by the card, but a
    // stored link the TO does not have must not 500 the release.
    await db.insert(bomComponents).values({ parentArticleId: parent.id, componentArticleId: part.id, quantity: "2", routingOperationId: kalkylOp.id });

    const order = await mfg.createManufacturingOrder({ articleId: parent.id, quantity: 5 }, user.id);
    expect(await materialLines(order.id)).toEqual([{ componentArticleId: part.id, quantityPlanned: "15.0000", sequenceNo: null }]);
  });
});

describe("aktivera en revision som inte finns", () => {
  it("leaves the article's active revision active", async () => {
    const article = await makeArticle("REV");
    const other = await makeArticle("ANNAN");
    const active = await articleService.createRevision(article.id, { revision: "1", isActive: true });
    const foreign = await articleService.createRevision(other.id, { revision: "9", isActive: true });

    for (const revisionId of [crypto.randomUUID(), foreign.id]) {
      await expect(articleService.updateRevision(article.id, revisionId, { isActive: true })).rejects.toBeInstanceOf(
        ArticleRevisionNotFoundError
      );
    }
    expect((await articleService.listRevisions(article.id)).map((r) => [r.id, r.isActive])).toEqual([[active.id, true]]);
  });

  it("leaves the drawing's active revision active", async () => {
    const article = await makeArticle("RIT");
    const drawing = await articleService.createDrawing(article.id, { drawingNumber: "R-1" });
    const revA = await articleService.createDrawingRevision(article.id, drawing.id, { revision: "A", isActive: true });
    const otherDrawing = await articleService.createDrawing(article.id, { drawingNumber: "R-2" });
    const foreign = await articleService.createDrawingRevision(article.id, otherDrawing.id, { revision: "X", isActive: true });

    for (const revisionId of [crypto.randomUUID(), foreign.id]) {
      await expect(articleService.updateDrawingRevision(article.id, drawing.id, revisionId, { isActive: true })).rejects.toBeInstanceOf(
        ArticleRevisionNotFoundError
      );
    }
    const drawings = await articleService.listDrawings(article.id);
    expect(drawings.find((d) => d.id === drawing.id)!.revisions.map((r) => [r.id, r.isActive])).toEqual([[revA.id, true]]);
  });
});

describe("typbyte till Tjänst med lagersaldo", () => {
  it("refuses while the article holds stock on any place, a blocked one too, and allows it at 0", async () => {
    const article = await makeArticle("TJ");
    const a = await makeLocation("A1");
    const b = await makeLocation("B1");
    await adjustStock(article.id, a.id, 5);
    await expect(articleService.updateArticle(article.id, { type: "service" })).rejects.toBeInstanceOf(ArticleHasStockError);

    // +5 here and −5 there is still stock to straighten out.
    await adjustStock(article.id, b.id, -5);
    await expect(articleService.updateArticle(article.id, { type: "service" })).rejects.toBeInstanceOf(ArticleHasStockError);

    await adjustStock(article.id, a.id, -5);
    await adjustStock(article.id, b.id, 5);
    const blocked = await makeLocation("K1", { blocked: true });
    await adjustStock(article.id, blocked.id, 2);
    await expect(articleService.updateArticle(article.id, { type: "service" })).rejects.toBeInstanceOf(ArticleHasStockError);
    expect((await articleService.getArticle(article.id))!.type).toBe("purchased");

    await adjustStock(article.id, blocked.id, -2);
    expect((await articleService.updateArticle(article.id, { type: "service" }))!.type).toBe("service");
  });

  it("allows an article that never had stock, and other type changes with stock", async () => {
    const empty = await makeArticle("TJ0");
    expect((await articleService.updateArticle(empty.id, { type: "service" }))!.type).toBe("service");

    const stocked = await makeArticle("TJ1");
    await adjustStock(stocked.id, (await makeLocation("A1")).id, 3);
    expect((await articleService.updateArticle(stocked.id, { type: "manufactured" }))!.type).toBe("manufactured");
  });

  it("waits for an inflow that has written its row and then refuses", async () => {
    const article = await makeArticle("TJ2");
    const location = await makeLocation("A1");
    const inflow = heldTransaction(async (tx) => {
      await tx.insert(stockTransactions).values({ articleId: article.id, locationId: location.id, quantityDelta: "4", transactionType: "inventory_adjustment" });
    });
    expect(await raceAgainst(inflow, () => articleService.updateArticle(article.id, { type: "service" }))).toBeInstanceOf(ArticleHasStockError);
  });

  it("makes a stock writer's type check wait for a type change in progress", async () => {
    const article = await makeArticle("TJ3");
    const change = heldTransaction(async (tx) => {
      await tx.select({ id: articles.id }).from(articles).where(eq(articles.id, article.id)).for("update");
      await tx.update(articles).set({ type: "service" }).where(eq(articles.id, article.id));
    });
    expect(await raceAgainst(change, () => db.transaction((tx) => isStockedArticle(tx, article.id)))).toBe(false);
  });
});

describe("Kopiera från — operationens ritning och filer", () => {
  const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==", "base64");
  const png = (filename: string) => ({ filename, contentType: "image/png", data: PNG });

  async function copyOf(sourceId: string) {
    return articleService.createArticle(
      parsed(createArticleSchema, {
        articleNumber: `KOPIA-${short()}`,
        name: "Kopia",
        type: "manufactured",
        active: true,
        copyFrom: { articleId: sourceId, parts: ["beredning", "filer"] },
      })
    );
  }

  it("gives the copied operation the files of its chosen drawing", async () => {
    const source = await makeArticle("SRC", { type: "manufactured" });
    const drawing = await articleService.createDrawing(source.id, { drawingNumber: "R-1" });
    const revA = await articleService.createDrawingRevision(source.id, drawing.id, { revision: "A", isActive: true });
    await articleService.addFile(source.id, png("a.png"), revA.id);
    await articleService.addFile(source.id, png("lös.png"));
    const wc = await makeWorkCenter();
    const sourceOp = await mfg.createRoutingOperation(
      source.id,
      parsed(createRoutingOperationSchema, { sequenceNo: 10, workCenterId: wc.id, setupTime: 1, runTimePerUnit: 1, drawingIds: [drawing.id] })
    );
    const names = async (articleId: string, routingOperationId: string) =>
      (await articleService.drawingFilesWithData({ articleId, routingOperationId })).map((f) => f.filename);
    expect(await names(source.id, sourceOp.id)).toEqual(["a.png"]);

    const copy = await copyOf(source.id);
    const [copyOp] = await mfg.listRoutingOperations(copy.id);
    // The same files as the source's operation — before, the revision-less
    // drawing alone was chosen and the operation got none.
    expect(await names(copy.id, copyOp!.id)).toEqual(["a.png"]);
    expect(copyOp!.drawings.map((d) => d.drawingNumber)).toEqual(["R-1"]);
  });

  it("links the copy of the chosen file, not every file with its name", async () => {
    const source = await makeArticle("SRC", { type: "manufactured" });
    const chosen = await articleService.addFile(source.id, png("ritning.png"));
    await articleService.addFile(source.id, png("ritning.png"));
    const wc = await makeWorkCenter();
    await mfg.createRoutingOperation(
      source.id,
      parsed(createRoutingOperationSchema, { sequenceNo: 10, workCenterId: wc.id, setupTime: 1, runTimePerUnit: 1, fileIds: [chosen.id] })
    );

    const copy = await copyOf(source.id);
    const [copyOp] = await mfg.listRoutingOperations(copy.id);
    expect(copyOp!.files.map((f) => f.filename)).toEqual(["ritning.png"]);
    expect((await articleService.drawingFilesWithData({ articleId: copy.id, routingOperationId: copyOp!.id })).length).toBe(1);
  });
});

describe("standardprishistoriken efter samtidiga ändringar", () => {
  it("records the second change when the first committed while it waited", async () => {
    const article = await makeArticle("STD", { standardCost: 10 });
    // Another change 10 → 20, written and not yet committed.
    const first = heldTransaction(async (tx) => {
      await tx.update(articles).set({ standardCost: "20" }).where(eq(articles.id, article.id));
      await recordStandardCostHistory(tx, [{ articleId: article.id, cost: 20 }]);
    });
    const outcome = await raceAgainst(first, () => articleService.updateStandardCost(article.id, 10));
    expect(outcome).not.toBeInstanceOf(Error);

    const [latest] = await db
      .select({ cost: articleStandardCostHistory.cost })
      .from(articleStandardCostHistory)
      .where(eq(articleStandardCostHistory.articleId, article.id))
      .orderBy(desc(articleStandardCostHistory.validFrom), desc(articleStandardCostHistory.id))
      .limit(1);
    expect(latest!.cost).toBe("10.0000");
    expect((await articleService.getArticle(article.id))!.standardCost).toBe("10.0000");
  });
});

describe("okänd Lagerplats och kollityp", () => {
  it("refuses an unknown Lagerplats on create and change, and an unknown kollityp on change", async () => {
    await expect(makeArticle("LP", { defaultLocationId: crypto.randomUUID() })).rejects.toBeInstanceOf(StockLocationNotFoundError);
    const article = await makeArticle("LP");
    await expect(articleService.updateArticle(article.id, { defaultLocationId: crypto.randomUUID() })).rejects.toBeInstanceOf(
      StockLocationNotFoundError
    );
    await expect(articleService.updateArticle(article.id, { packageTypeId: crypto.randomUUID() })).rejects.toBeInstanceOf(
      InvalidReferenceError
    );
  });
});

describe('reservenheten "st" när namnet Styck är upptaget', () => {
  it("creates st under a free name — for the article card and the import alike", async () => {
    const [seeded] = await db.select().from(units).where(eq(units.code, "st"));
    const parked = `st-${short()}`;
    // "Styck" stays taken: by the parked unit, or by a stand-in.
    if (seeded) await db.update(units).set({ code: parked }).where(eq(units.id, seeded.id));
    else await db.insert(units).values({ code: parked, name: "Styck" });
    try {
      const { unitId } = await importRepo.resolveDefaults();
      const [created] = await db.select().from(units).where(eq(units.id, unitId));
      expect([created!.code, created!.name]).toEqual(["st", "Styck (2)"]);
      const article = await makeArticle("ST");
      expect(article.unitId).toBe(unitId);
    } finally {
      await db.execute(TRUNCATE);
      await db.delete(units).where(eq(units.code, "st"));
      if (seeded) await db.update(units).set({ code: "st" }).where(eq(units.id, seeded.id));
      else await db.delete(units).where(eq(units.code, parked));
    }
  });
});

describe("en full artikelnummerserie i listan", () => {
  it("lists the full series with nextArticleNumber null and the others as before", async () => {
    const key = `article_full_${short()}`;
    const prefix = `FULL${short()}-`;
    await db.insert(numberSeries).values({ key, name: `Full ${key}`, prefix, nextNumber: 1, forArticles: true });
    const unitId = await articleRepo.getOrCreateDefaultUnitId();
    // 10 000 taken numbers in a row from the counter: the series is full.
    await db.execute(sql`
      INSERT INTO articles (article_number, name, type, unit_id)
      SELECT ${prefix} || n, 'Upptagen', 'purchased', ${unitId}::uuid FROM generate_series(1, 10000) n`);
    try {
      const series = await articleService.listArticleNumberSeries();
      expect(series.find((s) => s.key === key)!.nextArticleNumber).toBeNull();
      expect(series.find((s) => s.isDefault)!.nextArticleNumber).not.toBeNull();
    } finally {
      await db.execute(TRUNCATE);
      await db.delete(numberSeries).where(eq(numberSeries.key, key));
    }
  });
});

describe("cykelkontrollen i strukturen", () => {
  it("lets exactly one of two concurrent A → B and B → A through", async () => {
    const a = await makeArticle("A", { type: "manufactured" });
    const b = await makeArticle("B", { type: "manufactured" });
    const results = await Promise.allSettled([
      articleService.addBomComponent(a.id, { componentArticleId: b.id, quantity: 1 }),
      articleService.addBomComponent(b.id, { componentArticleId: a.id, quantity: 1 }),
    ]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    const [refused] = results.filter((r) => r.status === "rejected");
    expect((refused as PromiseRejectedResult).reason).toBeInstanceOf(BomCycleError);
    expect(await db.select().from(bomComponents)).toHaveLength(1);
  });

  it("waits for an add in progress and sees it", async () => {
    const a = await makeArticle("A", { type: "manufactured" });
    const b = await makeArticle("B", { type: "manufactured" });
    const c = await makeArticle("C", { type: "manufactured" });
    // A → B → C in progress; C → A would close the loop.
    await articleService.addBomComponent(b.id, { componentArticleId: c.id, quantity: 1 });
    const adding = heldTransaction(async (tx) => {
      await tx.execute(BOM_STRUCTURE_LOCK_SQL);
      await tx.insert(bomComponents).values({ parentArticleId: a.id, componentArticleId: b.id, quantity: "1" });
    });
    const closing = await raceAgainst(adding, () => articleService.addBomComponent(c.id, { componentArticleId: a.id, quantity: 1 }));
    expect(closing).toBeInstanceOf(BomCycleError);
    expect(await articleService.isDescendant(a.id, c.id)).toBe(true);
    expect(await articleService.isDescendant(c.id, a.id)).toBe(false);
  });

  it("refuses the article as its own component", async () => {
    const a = await makeArticle("A", { type: "manufactured" });
    await expect(articleService.addBomComponent(a.id, { componentArticleId: a.id, quantity: 1 })).rejects.toBeInstanceOf(BomCycleError);
  });
});

describe("UPC-A och EAN-13 är samma kod", () => {
  const UPC = "036000291452";
  const EAN = "0036000291452";
  const GTIN14 = "00036000291452";

  it("normalizes every form of a GTIN to one key (pure)", () => {
    expect(gtinKey(UPC)).toBe(GTIN14);
    expect(gtinKey(EAN)).toBe(GTIN14);
    expect(gtinKey(GTIN14)).toBe(GTIN14);
    expect(gtinKey("036000291453")).toBeNull();
    expect(gtinKey("PL-10")).toBeNull();
    expect(gtinForms(EAN)).toEqual([GTIN14, EAN, UPC]);
    expect(gtinForms("96385074")).toEqual(["00000096385074", "0000096385074", "000096385074", "96385074"]);
    expect(gtinForms("7350000000016")).toEqual(["07350000000016", "7350000000016"]);
  });

  it("finds the article whichever form is scanned", async () => {
    const article = await makeArticle("UPC", { barcode: UPC });
    for (const code of [UPC, EAN, GTIN14]) {
      const { matches } = await scanService.resolve(code);
      expect(matches).toEqual([expect.objectContaining({ kind: "article", id: article.id, matchedBy: "barcode" })]);
    }
  });

  it("refuses the same GTIN in another form on another article, and lets the article keep its own", async () => {
    const article = await makeArticle("UPC", { barcode: UPC });
    await expect(makeArticle("EAN", { barcode: EAN })).rejects.toBeInstanceOf(DuplicateArticleBarcodeError);
    const other = await makeArticle("ANNAN");
    await expect(articleService.updateArticle(other.id, { barcode: GTIN14 })).rejects.toBeInstanceOf(DuplicateArticleBarcodeError);
    expect((await articleService.updateArticle(article.id, { barcode: EAN }))!.barcode).toBe(EAN);
  });

  it("is one code in the article import, against the register and within the file", async () => {
    const holder = await makeArticle("UPC", { barcode: UPC });
    const preview = await importService.preview("articles", {
      mapping: { Artikelnummer: "articleNumber", Benämning: "name", EAN: "barcode" },
      rows: [
        ["NY-1", "Ny", EAN],
        ["NY-2", "Ny", "96385074"],
        ["NY-3", "Ny", "0000096385074"],
      ],
    });
    expect(preview.rows.map((r) => r.errors)).toEqual([
      [`Streckkoden ${EAN} finns redan på artikel ${holder.articleNumber}`],
      [],
      ["Streckkoden 0000096385074 står också på artikel NY-2 i filen"],
    ]);
  });
});

describe("rutterna", () => {
  const PASSWORD = "ett-tillräckligt-långt-lösenord";
  let app: ReturnType<typeof buildApp>;
  let admin: string;
  const cookieOf = (res: { cookies: { name: string; value: string }[] }) => res.cookies.map((c) => `${c.name}=${c.value}`).join("; ");
  const call = (method: string, url: string, payload?: unknown) =>
    app.inject({ method: method as never, url: `/api/v1${url}`, headers: { cookie: admin }, ...(payload === undefined ? {} : { payload: payload as never }) });

  beforeEach(async () => {
    app = buildApp();
    await app.inject({
      method: "POST",
      url: "/api/v1/auth/register",
      payload: { email: "admin@example.com", password: PASSWORD, name: "Admin", setupCode: app.setup.code.code },
    });
    admin = cookieOf(await app.inject({ method: "POST", url: "/api/v1/auth/login", payload: { email: "admin@example.com", password: PASSWORD } }));
  });

  it("answers 409 article-has-stock, 404 for an unknown Lagerplats and 400 for an unknown kollityp", async () => {
    const article = await makeArticle("R");
    await adjustStock(article.id, (await makeLocation("A1")).id, 1);
    const typeChange = await call("PATCH", `/articles/${article.id}`, { type: "service" });
    expect([typeChange.statusCode, typeChange.json().code]).toEqual([409, "article-has-stock"]);

    const batch = await call("PATCH", "/articles/batch", { rows: [{ id: article.id, type: "service" }] });
    expect(batch.json().results[0].error.code).toBe("article-has-stock");

    const created = await call("POST", "/articles", { articleNumber: `R-${short()}`, name: "x", type: "purchased", active: true, defaultLocationId: crypto.randomUUID() });
    expect([created.statusCode, created.json().code]).toEqual([404, "stock-location-not-found"]);
    const moved = await call("PATCH", `/articles/${article.id}`, { defaultLocationId: crypto.randomUUID() });
    expect(moved.statusCode).toBe(404);
    const packaged = await call("PATCH", `/articles/${article.id}`, { packageTypeId: crypto.randomUUID() });
    expect([packaged.statusCode, packaged.json().code]).toEqual([400, "invalid-reference"]);
  });

  it("serves the article number series when one is full", async () => {
    const key = `article_full_${short()}`;
    const prefix = `FULL${short()}-`;
    await db.insert(numberSeries).values({ key, name: `Full ${key}`, prefix, nextNumber: 1, forArticles: true });
    const unitId = await articleRepo.getOrCreateDefaultUnitId();
    await db.execute(sql`
      INSERT INTO articles (article_number, name, type, unit_id)
      SELECT ${prefix} || n, 'Upptagen', 'purchased', ${unitId}::uuid FROM generate_series(1, 10000) n`);
    try {
      const res = await call("GET", "/article-number-series");
      expect(res.statusCode).toBe(200);
      expect((res.json() as { key: string; nextArticleNumber: string | null }[]).find((s) => s.key === key)!.nextArticleNumber).toBeNull();
    } finally {
      await db.execute(TRUNCATE);
      await db.delete(numberSeries).where(eq(numberSeries.key, key));
    }
  });
});

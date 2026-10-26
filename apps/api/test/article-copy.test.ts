import { afterAll, beforeEach, describe, expect, it } from "vitest";
import Fastify from "fastify";
import { ZodError } from "zod";
import { asc, eq, sql } from "drizzle-orm";
import {
  articleDrawingRevisions,
  articleDrawings,
  articleFiles,
  articleRevisions,
  articleSupplierPriceBreaks,
  articleSuppliers,
  articleUnits,
  articles,
  bomComponents,
  configuratorTemplates,
  db,
  packageTypes,
  routingOperationFiles,
  routingOperations,
  stockTransactions,
  suppliers,
  units,
  workCenters,
} from "@navet/db";
import { createArticleSchema, type CreateArticleInput } from "@navet/shared";
import { createArticleRepository } from "../src/modules/article/repository/article.repository.js";
import {
  ArticleCopyPartNotAllowedError,
  ArticleNotFoundError,
  createArticleService,
} from "../src/modules/article/service/article.service.js";
import { articleRoutes } from "../src/modules/article/routes/article.routes.js";

// "Kopiera från befintlig artikel": POST /articles with copyFrom copies the
// chosen parts of a source article (Information, Beredning, Inköp, Ritningar
// och filer) into the new article in the SAME transaction as the create.

const service = createArticleService(createArticleRepository(db));

const RESET = sql`TRUNCATE configurator_templates, article_supplier_price_breaks, article_suppliers, suppliers,
  routing_operation_files, bom_components, routing_operations, work_centers, article_files,
  article_drawing_revisions, article_drawings, article_revisions, article_units, stock_transactions,
  article_standard_cost_history, articles, article_groups, package_types, units CASCADE`;

beforeEach(async () => {
  await db.execute(RESET);
});
afterAll(async () => {
  await db.execute(RESET);
});

const create = (input: Record<string, unknown>) => service.createArticle(createArticleSchema.parse(input) as CreateArticleInput);

interface Fixture {
  source: { id: string };
  stId: string;
  kgId: string;
  compA: { id: string };
  compB: { id: string };
  op10: { id: string };
  op20: { id: string };
  primarySupplierId: string;
  otherSupplierId: string;
  packageTypeId: string;
}

// A source article with something in every copyable part — and in the parts
// that must never be copied (stock, revisions, configurator template).
async function buildSource(): Promise<Fixture> {
  const [st, kg] = await db
    .insert(units)
    .values([{ code: "st", name: "Styck" }, { code: "kg", name: "Kilogram" }])
    .returning();
  const [pkg] = await db.insert(packageTypes).values({ code: "EUR", name: "EUR-pall" }).returning();
  const source = await create({
    articleNumber: "SRC-1",
    name: "Källartikel",
    type: "manufactured",
    unitId: st!.id,
    standardCost: 12.5,
    salesPrice: 99.1234,
    weight: 1.234,
    length: 100,
    width: 50.5,
    height: 20,
    quantityPerPackage: 40,
    packageTypeId: pkg!.id,
    parcelKind: "pallet",
    stackable: true,
    palletSpaces: 2,
    loadingMeters: 0.8,
    reorderPoint: 10,
    orderQuantity: 25,
    rounding: 0.5,
    surfaceTreatment: "Pulverlack",
    colour: "RAL 9005",
  });
  await db.insert(articleUnits).values({ articleId: source.id, unitId: kg!.id, quantityPerBase: "5.000000" });
  await db.update(articles).set({ purchaseUnitId: kg!.id, salesUnitId: kg!.id }).where(eq(articles.id, source.id));

  const compA = await create({ articleNumber: "COMP-A", name: "Komponent A", type: "purchased", unitId: st!.id });
  const compB = await create({ articleNumber: "COMP-B", name: "Komponent B", type: "purchased", unitId: st!.id });

  const [wc] = await db.insert(workCenters).values({ code: "100", name: "Kap" }).returning();
  const [op10, op20] = await db
    .insert(routingOperations)
    .values([
      {
        articleId: source.id,
        sequenceNo: 10,
        description: "Kapning",
        workCenterId: wc!.id,
        setupTime: "15.00",
        runTimePerUnit: "1.2500",
        comment: "Grada kanterna",
        printOnWorkCard: true,
        packingInstructions: "På pall",
      },
      {
        articleId: source.id,
        sequenceNo: 20,
        description: "Svetsning",
        workCenterId: wc!.id,
        setupTime: "5.00",
        runTimePerUnit: "0.1667",
        timeUnit: "units_per_hour",
        useArticleDrawing: false,
      },
    ])
    .returning();
  await db.insert(routingOperationFiles).values({
    routingOperationId: op20!.id,
    filename: "op20.pdf",
    contentType: "application/pdf",
    sizeBytes: 7,
    data: Buffer.from("op-file"),
  });
  await db.insert(bomComponents).values([
    { parentArticleId: source.id, componentArticleId: compA.id, quantity: "2.5000", routingOperationId: op20!.id },
    { parentArticleId: source.id, componentArticleId: compB.id, quantity: "1.0000" },
  ]);

  const [s1, s2] = await db
    .insert(suppliers)
    .values([
      { supplierNumber: "L1", name: "Alfa AB" },
      { supplierNumber: "L2", name: "Beta AB" },
    ])
    .returning();
  const [primary] = await db
    .insert(articleSuppliers)
    .values({
      articleId: source.id,
      supplierId: s1!.id,
      supplierArticleNumber: "ALFA-77",
      price: "10.5000",
      currency: "EUR",
      leadTimeDays: 14,
      isPrimary: true,
    })
    .returning();
  await db.insert(articleSuppliers).values({ articleId: source.id, supplierId: s2!.id, price: "11.0000" });
  await db.insert(articleSupplierPriceBreaks).values([
    { articleSupplierId: primary!.id, fromQuantity: "10.0000", price: "9.5000" },
    { articleSupplierId: primary!.id, fromQuantity: "100.0000", price: "8.0000" },
  ]);

  await db.insert(articleFiles).values([
    { articleId: source.id, filename: "ritning.pdf", contentType: "application/pdf", sizeBytes: 11, data: Buffer.from("pdf-bytes-1") },
    { articleId: source.id, filename: "bild.png", contentType: "image/png", sizeBytes: 4, data: Buffer.from([0, 1, 2, 255]) },
  ]);
  const [drawing] = await db.insert(articleDrawings).values({ articleId: source.id, drawingNumber: "R-1001" }).returning();
  await db.insert(articleDrawingRevisions).values({ drawingId: drawing!.id, revision: "A", isActive: true });
  await db.insert(articleRevisions).values({ articleId: source.id, revision: "B", isActive: true });

  const location = await createArticleRepository(db).getOrCreateFallbackLocationId();
  await db.insert(stockTransactions).values({
    articleId: source.id,
    locationId: location,
    quantityDelta: "5",
    transactionType: "inventory_adjustment",
  } as never);
  await db.insert(configuratorTemplates).values({ articleId: source.id, mode: "to_order" });

  return {
    source,
    stId: st!.id,
    kgId: kg!.id,
    compA,
    compB,
    op10: op10!,
    op20: op20!,
    primarySupplierId: s1!.id,
    otherSupplierId: s2!.id,
    packageTypeId: pkg!.id,
  };
}

const INFO_FIELDS = [
  "purchaseUnitId",
  "salesUnitId",
  "salesPrice",
  "weight",
  "length",
  "width",
  "height",
  "quantityPerPackage",
  "packageTypeId",
  "parcelKind",
  "stackable",
  "palletSpaces",
  "loadingMeters",
  "reorderPoint",
  "orderQuantity",
  "rounding",
  "surfaceTreatment",
  "colour",
] as const;

async function articleRow(id: string) {
  const [row] = await db.select().from(articles).where(eq(articles.id, id));
  return row!;
}

async function routingOf(articleId: string) {
  return db.select().from(routingOperations).where(eq(routingOperations.articleId, articleId)).orderBy(asc(routingOperations.sequenceNo));
}
async function bomOf(articleId: string) {
  return db.select().from(bomComponents).where(eq(bomComponents.parentArticleId, articleId)).orderBy(asc(bomComponents.quantity));
}
async function suppliersOf(articleId: string) {
  return db.select().from(articleSuppliers).where(eq(articleSuppliers.articleId, articleId)).orderBy(asc(articleSuppliers.price));
}
async function breaksOf(articleSupplierId: string) {
  return db
    .select({ fromQuantity: articleSupplierPriceBreaks.fromQuantity, price: articleSupplierPriceBreaks.price })
    .from(articleSupplierPriceBreaks)
    .where(eq(articleSupplierPriceBreaks.articleSupplierId, articleSupplierId))
    .orderBy(asc(articleSupplierPriceBreaks.fromQuantity));
}
async function filesOf(articleId: string) {
  const result = await db.execute<{ filename: string; content_type: string; size_bytes: number; len: number; sha: string }>(
    sql`SELECT filename, content_type, size_bytes, length(data) AS len, encode(sha256(data), 'hex') AS sha
        FROM article_files WHERE article_id = ${articleId} ORDER BY filename`
  );
  return [...result];
}
async function drawingsOf(articleId: string) {
  return db.select({ drawingNumber: articleDrawings.drawingNumber }).from(articleDrawings).where(eq(articleDrawings.articleId, articleId));
}
async function countWhere(table: string, column: string, id: string) {
  const result = await db.execute<{ n: number }>(sql`SELECT count(*)::int AS n FROM ${sql.raw(table)} WHERE ${sql.raw(column)} = ${id}`);
  return result[0]!.n;
}

// Everything but the identity columns.
function strip<T extends Record<string, unknown>>(row: T, ...keys: string[]) {
  const copy: Record<string, unknown> = { ...row };
  for (const key of ["id", "createdAt", ...keys]) delete copy[key];
  return copy;
}

describe("POST /articles copyFrom — Information", () => {
  it("copies the Allmänt/planning fields and alternative units, the form wins for what it sends", async () => {
    const f = await buildSource();
    const created = await create({
      articleNumber: "NEW-1",
      name: "Ny artikel",
      type: "purchased",
      unitId: f.stId,
      standardCost: 3,
      colour: "Röd",
      copyFrom: { articleId: f.source.id, parts: ["information"] },
    });
    const src = await articleRow(f.source.id);
    const row = await articleRow(created.id);

    expect(row).toMatchObject({ articleNumber: "NEW-1", name: "Ny artikel", type: "purchased", standardCost: "3.0000", active: true });
    for (const field of INFO_FIELDS) {
      if (field === "colour") continue;
      expect(row[field], field).toEqual(src[field]);
    }
    expect(row.colour).toBe("Röd");
    expect(row.groupId).toBeNull();

    const altUnits = await db.select().from(articleUnits).where(eq(articleUnits.articleId, created.id));
    expect(altUnits.map((u) => ({ unitId: u.unitId, quantityPerBase: u.quantityPerBase }))).toEqual([
      { unitId: f.kgId, quantityPerBase: "5.000000" },
    ]);

    // Only Information was chosen: nothing else follows.
    expect(await routingOf(created.id)).toEqual([]);
    expect(await bomOf(created.id)).toEqual([]);
    expect(await suppliersOf(created.id)).toEqual([]);
    expect(await filesOf(created.id)).toEqual([]);
    expect(await drawingsOf(created.id)).toEqual([]);
  });

  it("skips alternative units and default units when the new base unit differs", async () => {
    const f = await buildSource();
    const created = await create({
      articleNumber: "NEW-KG",
      name: "Ny i kg",
      type: "purchased",
      unitId: f.kgId,
      copyFrom: { articleId: f.source.id, parts: ["information"] },
    });
    const row = await articleRow(created.id);
    expect(row.unitId).toBe(f.kgId);
    expect(row.purchaseUnitId).toBeNull();
    expect(row.salesUnitId).toBeNull();
    expect(row.salesPrice).toBe("99.1234");
    expect(await db.select().from(articleUnits).where(eq(articleUnits.articleId, created.id))).toEqual([]);
  });

  it("accepts a default unit from the source's alternative units when the base unit matches", async () => {
    const f = await buildSource();
    const created = await create({
      articleNumber: "NEW-PU",
      name: "Ny",
      type: "purchased",
      unitId: f.stId,
      purchaseUnitId: f.stId,
      copyFrom: { articleId: f.source.id, parts: ["information"] },
    });
    const row = await articleRow(created.id);
    expect(row.purchaseUnitId).toBe(f.stId);
    expect(row.salesUnitId).toBe(f.kgId);
  });
});

describe("POST /articles copyFrom — Beredning", () => {
  it("copies routing operations (with their file) and BOM rows, remapping material links to the new operations", async () => {
    const f = await buildSource();
    const created = await create({
      articleNumber: "NEW-B",
      name: "Ny tillverkad",
      type: "manufactured",
      copyFrom: { articleId: f.source.id, parts: ["beredning"] },
    });

    const srcOps = await routingOf(f.source.id);
    const newOps = await routingOf(created.id);
    expect(newOps).toHaveLength(2);
    expect(newOps.map((op) => strip(op, "articleId"))).toEqual(srcOps.map((op) => strip(op, "articleId")));
    expect(newOps.every((op) => op.articleId === created.id)).toBe(true);
    const newOp20 = newOps.find((op) => op.sequenceNo === 20)!;
    expect(newOp20.id).not.toBe(f.op20.id);

    const opFile = await db.execute<{ filename: string; sha: string }>(
      sql`SELECT filename, encode(sha256(data), 'hex') AS sha FROM routing_operation_files WHERE routing_operation_id = ${newOp20.id}`
    );
    expect([...opFile]).toEqual([{ filename: "op20.pdf", sha: (await db.execute<{ sha: string }>(sql`SELECT encode(sha256('op-file'::bytea), 'hex') AS sha`))[0]!.sha }]);

    const newBom = await bomOf(created.id);
    expect(newBom.map((r) => ({ c: r.componentArticleId, q: r.quantity, op: r.routingOperationId }))).toEqual([
      { c: f.compB.id, q: "1.0000", op: null },
      { c: f.compA.id, q: "2.5000", op: newOp20.id },
    ]);

    // The source is untouched.
    expect(await routingOf(f.source.id)).toHaveLength(2);
    expect((await bomOf(f.source.id)).find((r) => r.componentArticleId === f.compA.id)!.routingOperationId).toBe(f.op20.id);
    // Information was not chosen.
    expect((await articleRow(created.id)).salesPrice).toBeNull();
  });
});

describe("POST /articles copyFrom — Inköp", () => {
  it("copies the supplier catalog with the primary flag and price breaks", async () => {
    const f = await buildSource();
    const created = await create({
      articleNumber: "NEW-I",
      name: "Ny köpt",
      type: "purchased",
      copyFrom: { articleId: f.source.id, parts: ["inkop"] },
    });
    const srcRows = await suppliersOf(f.source.id);
    const newRows = await suppliersOf(created.id);
    expect(newRows.map((r) => strip(r, "articleId"))).toEqual(srcRows.map((r) => strip(r, "articleId")));
    const newPrimary = newRows.find((r) => r.isPrimary)!;
    expect(newPrimary.supplierId).toBe(f.primarySupplierId);
    expect(await breaksOf(newPrimary.id)).toEqual([
      { fromQuantity: "10.0000", price: "9.5000" },
      { fromQuantity: "100.0000", price: "8.0000" },
    ]);
    expect(await breaksOf(newRows.find((r) => !r.isPrimary)!.id)).toEqual([]);
    // The source keeps its own catalog.
    expect(await suppliersOf(f.source.id)).toHaveLength(2);
  });

  it("also copies to a service article", async () => {
    const f = await buildSource();
    const created = await create({
      articleNumber: "NEW-T",
      name: "Ny tjänst",
      type: "service",
      copyFrom: { articleId: f.source.id, parts: ["inkop"] },
    });
    expect(await suppliersOf(created.id)).toHaveLength(2);
  });
});

describe("POST /articles copyFrom — Ritningar och filer", () => {
  it("copies files byte for byte and drawing numbers, but not revisions", async () => {
    const f = await buildSource();
    const created = await create({
      articleNumber: "NEW-F",
      name: "Ny med filer",
      type: "purchased",
      copyFrom: { articleId: f.source.id, parts: ["filer"] },
    });
    const srcFiles = await filesOf(f.source.id);
    expect(srcFiles).toHaveLength(2);
    expect(await filesOf(created.id)).toEqual(srcFiles);
    expect(await drawingsOf(created.id)).toEqual([{ drawingNumber: "R-1001" }]);
    const [newDrawing] = await db.select().from(articleDrawings).where(eq(articleDrawings.articleId, created.id));
    expect(await countWhere("article_drawing_revisions", "drawing_id", newDrawing!.id)).toBe(0);
    expect(await countWhere("article_revisions", "article_id", created.id)).toBe(0);
  });
});

describe("POST /articles copyFrom — all parts", () => {
  it("copies everything at once and never stock, revisions or the configurator template", async () => {
    const f = await buildSource();
    const created = await create({
      articleNumber: "NEW-ALL",
      name: "Allt",
      type: "manufactured",
      unitId: f.stId,
      copyFrom: { articleId: f.source.id, parts: ["information", "beredning", "filer"] },
    });
    expect((await articleRow(created.id)).salesPrice).toBe("99.1234");
    expect(await routingOf(created.id)).toHaveLength(2);
    expect(await bomOf(created.id)).toHaveLength(2);
    expect(await filesOf(created.id)).toHaveLength(2);
    expect(await drawingsOf(created.id)).toHaveLength(1);
    expect(await countWhere("article_units", "article_id", created.id)).toBe(1);

    expect(await countWhere("stock_transactions", "article_id", created.id)).toBe(0);
    expect(await countWhere("configurator_templates", "article_id", created.id)).toBe(0);
    expect(await countWhere("article_revisions", "article_id", created.id)).toBe(0);
    expect(await countWhere("article_suppliers", "article_id", created.id)).toBe(0);

    // And the purchased variant takes Inköp alongside the rest.
    const purchased = await create({
      articleNumber: "NEW-ALL-2",
      name: "Allt köpt",
      type: "purchased",
      unitId: f.stId,
      copyFrom: { articleId: f.source.id, parts: ["information", "inkop", "filer"] },
    });
    expect(await suppliersOf(purchased.id)).toHaveLength(2);
    expect(await filesOf(purchased.id)).toHaveLength(2);
    expect(await routingOf(purchased.id)).toEqual([]);
  });
});

describe("POST /articles copyFrom — rules", () => {
  it("rejects Beredning unless the new article is manufactured, and Inköp unless purchased/service", async () => {
    const f = await buildSource();
    await expect(
      create({ articleNumber: "X-1", name: "x", type: "purchased", copyFrom: { articleId: f.source.id, parts: ["beredning"] } })
    ).rejects.toThrow(ArticleCopyPartNotAllowedError);
    await expect(
      create({ articleNumber: "X-2", name: "x", type: "manufactured", copyFrom: { articleId: f.source.id, parts: ["inkop"] } })
    ).rejects.toThrow(ArticleCopyPartNotAllowedError);
    expect(await db.select().from(articles).where(eq(articles.articleNumber, "X-1"))).toEqual([]);
    expect(await db.select().from(articles).where(eq(articles.articleNumber, "X-2"))).toEqual([]);
  });

  it("404s an unknown source article", async () => {
    await expect(
      create({ articleNumber: "X-3", name: "x", type: "purchased", copyFrom: { articleId: crypto.randomUUID(), parts: ["information"] } })
    ).rejects.toThrow(ArticleNotFoundError);
  });

  it("validates parts: at least one, no duplicates, known values only", () => {
    const id = crypto.randomUUID();
    const base = { articleNumber: "Z", name: "z", type: "purchased" };
    expect(createArticleSchema.safeParse({ ...base, copyFrom: { articleId: id, parts: [] } }).success).toBe(false);
    expect(createArticleSchema.safeParse({ ...base, copyFrom: { articleId: id, parts: ["filer", "filer"] } }).success).toBe(false);
    expect(createArticleSchema.safeParse({ ...base, copyFrom: { articleId: id, parts: ["lager"] } }).success).toBe(false);
    expect(createArticleSchema.safeParse({ ...base, copyFrom: { articleId: "nope", parts: ["filer"] } }).success).toBe(false);
    expect(createArticleSchema.safeParse({ ...base, copyFrom: { articleId: id, parts: ["filer", "information"] } }).success).toBe(true);
  });

  it("rolls back the whole create when the copy fails half-way", async () => {
    const f = await buildSource();
    // Fail the LAST step (drawing numbers) so the article, routing, BOM and
    // files have all been written inside the transaction by then.
    await db.execute(sql`CREATE OR REPLACE FUNCTION test_fail_copy() RETURNS trigger AS $$
      BEGIN RAISE EXCEPTION 'forced copy failure'; END $$ LANGUAGE plpgsql`);
    await db.execute(sql`CREATE TRIGGER test_fail_copy BEFORE INSERT ON article_drawings FOR EACH ROW EXECUTE FUNCTION test_fail_copy()`);
    try {
      await expect(
        create({
          articleNumber: "ROLLBACK",
          name: "Ska inte finnas",
          type: "manufactured",
          standardCost: 5,
          copyFrom: { articleId: f.source.id, parts: ["information", "beredning", "filer"] },
        })
      ).rejects.toThrow();
    } finally {
      await db.execute(sql`DROP TRIGGER IF EXISTS test_fail_copy ON article_drawings`);
      await db.execute(sql`DROP FUNCTION IF EXISTS test_fail_copy()`);
    }
    expect(await db.select().from(articles).where(eq(articles.articleNumber, "ROLLBACK"))).toEqual([]);
    const counts = await db.execute<{ ops: number; bom: number; files: number; units: number; history: number }>(sql`
      SELECT (SELECT count(*)::int FROM routing_operations) AS ops,
             (SELECT count(*)::int FROM bom_components) AS bom,
             (SELECT count(*)::int FROM article_files) AS files,
             (SELECT count(*)::int FROM article_units) AS units,
             (SELECT count(*)::int FROM article_standard_cost_history WHERE cost = 5) AS history`);
    expect(counts[0]).toEqual({ ops: 2, bom: 2, files: 2, units: 1, history: 0 });
  });
});

describe("POST /articles copyFrom — route", () => {
  function buildApp() {
    const app = Fastify();
    app.setErrorHandler((err, _req, reply) => {
      if (err instanceof ZodError) return reply.code(400).send({ error: "Validation failed", code: "validation-failed" });
      throw err;
    });
    app.register(articleRoutes, { service });
    return app;
  }

  it("maps the type rule to 400 and an unknown source to 404, and creates with 201", async () => {
    const f = await buildSource();
    const app = buildApp();
    const notAllowed = await app.inject({
      method: "POST",
      url: "/articles",
      payload: { articleNumber: "R-1", name: "r", type: "service", copyFrom: { articleId: f.source.id, parts: ["beredning"] } },
    });
    expect(notAllowed.statusCode).toBe(400);
    expect(notAllowed.json()).toMatchObject({ code: "article-copy-part-not-allowed" });

    const unknown = await app.inject({
      method: "POST",
      url: "/articles",
      payload: { articleNumber: "R-2", name: "r", type: "purchased", copyFrom: { articleId: crypto.randomUUID(), parts: ["filer"] } },
    });
    expect(unknown.statusCode).toBe(404);
    expect(unknown.json()).toMatchObject({ code: "article-not-found" });

    const ok = await app.inject({
      method: "POST",
      url: "/articles",
      payload: { articleNumber: "R-3", name: "r", type: "purchased", copyFrom: { articleId: f.source.id, parts: ["inkop", "filer"] } },
    });
    expect(ok.statusCode).toBe(201);
    expect(await suppliersOf(ok.json().id)).toHaveLength(2);
    await app.close();
  });
});

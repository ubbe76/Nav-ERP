import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { and, eq, sql } from "drizzle-orm";
import { auditLog, db, manufacturingOrders } from "@navet/db";
import { createArticleSchema, createRoutingOperationSchema, createWorkCenterSchema, type CreateArticleInput } from "@navet/shared";
import { testDocumentPdfService } from "./helpers/services.js";
import { parsed } from "./helpers/parsed.js";
import { pdfText } from "./helpers/pdf.js";
import { createArticleRepository } from "../src/modules/article/repository/article.repository.js";
import { createArticleService, DrawingFileNotLooseError } from "../src/modules/article/service/article.service.js";
import { createAuthRepository } from "../src/modules/auth/repository/auth.repository.js";
import { createManufacturingRepository } from "../src/modules/manufacturing/repository/manufacturing.repository.js";
import {
  createManufacturingService,
  ManufacturingOrderNotEditableError,
  RoutingDrawingInvalidError,
} from "../src/modules/manufacturing/service/manufacturing.service.js";
import { createSalesRepository } from "../src/modules/sales/repository/sales.repository.js";
import { markSalesOrderInProduction } from "../src/modules/sales/service/production-transition.js";
import { createAuditRepository } from "../src/modules/system/repository/audit.repository.js";

// Ritningar, revisioner och filer i beredningen (spec
// private/superpowers/specs/2026-11-09-ritningar-revisioner-filer-design.md):
// a drawing revision's file, the files in force, the revisions a TO is built
// from (snapshot, Uppdatera), the operations' chosen drawings, the printout
// and Kopiera från.

const articleService = createArticleService(createArticleRepository(db));
const authRepo = createAuthRepository(db);
const salesRepository = createSalesRepository(db);
const mfg = createManufacturingService(
  createManufacturingRepository(db),
  testDocumentPdfService,
  articleService,
  {
    findRowForManufacturing: salesRepository.findRowForManufacturing,
    lockRowForManufacturing: salesRepository.lockRowForManufacturing,
    markInProduction: markSalesOrderInProduction,
  },
  createAuditRepository(db)
);

const TRUNCATE = sql`TRUNCATE mo_drawing_revisions, mo_material_consumptions, mo_operations, manufacturing_orders, routing_operation_drawings, routing_operations, work_centers, article_files, article_drawing_revisions, article_drawings, article_revisions, bom_components, articles, audit_log, users CASCADE`;

beforeEach(async () => {
  await db.execute(TRUNCATE);
});
afterAll(async () => {
  await db.execute(TRUNCATE);
});

// A 1×1 PNG: a real image the printout can append as a page.
const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64"
);
const png = (filename: string) => ({ filename, contentType: "image/png", data: PNG });

async function makeUser() {
  return authRepo.create({
    email: `rit-${crypto.randomUUID()}@example.com`,
    passwordHash: "not-a-real-hash",
    name: "Beredare",
    role: "admin",
  });
}

async function makeArticle() {
  return articleService.createArticle(
    parsed(createArticleSchema, { articleNumber: `RIT-${crypto.randomUUID().slice(0, 8)}`, name: "Bänkskiva", type: "manufactured", active: true })
  );
}

// R-1 with rev A (active, file a.png) and rev B (inactive, file b.png); a
// loose file lös.png; article revision 1.
async function makeDrawingArticle() {
  const article = await makeArticle();
  await articleService.createRevision(article.id, { revision: "1", isActive: true });
  const drawing = await articleService.createDrawing(article.id, { drawingNumber: "R-1" });
  const revA = await articleService.createDrawingRevision(article.id, drawing.id, { revision: "A", isActive: true });
  const revB = await articleService.createDrawingRevision(article.id, drawing.id, { revision: "B", isActive: false });
  const fileA = await articleService.addFile(article.id, png("a.png"), revA.id);
  const fileB = await articleService.addFile(article.id, png("b.png"), revB.id);
  const loose = await articleService.addFile(article.id, png("lös.png"));
  return { article, drawing, revA, revB, fileA, fileB, loose };
}

describe("ritningsrevisionens fil", () => {
  it("uploads onto a revision, lists it on the revision and in Filer, and replaces it on a new upload", async () => {
    const f = await makeDrawingArticle();
    const [drawing] = await articleService.listDrawings(f.article.id);
    expect(drawing!.revisions.map((r) => [r.revision, r.isActive, r.file?.filename])).toEqual([
      ["A", true, "a.png"],
      ["B", false, "b.png"],
    ]);
    const files = await articleService.listFiles(f.article.id);
    expect(files.map((x) => [x.filename, x.drawingNumber, x.revision, x.revisionActive])).toEqual([
      ["a.png", "R-1", "A", true],
      ["b.png", "R-1", "B", false],
      ["lös.png", null, null, null],
    ]);

    // Byt fil: the old file is deleted.
    await articleService.addFile(f.article.id, png("a2.png"), f.revA.id);
    const after = await articleService.listFiles(f.article.id);
    expect(after.map((x) => x.filename)).toEqual(["a2.png", "b.png", "lös.png"]);
  });

  it("takes a loose file onto a revision, refuses another revision's file, and deletes it with the revision", async () => {
    const f = await makeDrawingArticle();
    const revC = await articleService.createDrawingRevision(f.article.id, f.drawing.id, { revision: "C", isActive: false });
    await articleService.linkDrawingRevisionFile(f.article.id, f.drawing.id, revC.id, f.loose.id);
    expect((await articleService.listFiles(f.article.id)).find((x) => x.id === f.loose.id)!.revision).toBe("C");
    await expect(articleService.linkDrawingRevisionFile(f.article.id, f.drawing.id, revC.id, f.fileA.id)).rejects.toBeInstanceOf(
      DrawingFileNotLooseError
    );

    await articleService.deleteDrawingRevision(f.article.id, f.drawing.id, revC.id);
    expect((await articleService.listFiles(f.article.id)).map((x) => x.filename)).toEqual(["a.png", "b.png"]);
  });

  it("refuses a revision of another article on upload", async () => {
    const f = await makeDrawingArticle();
    const other = await makeArticle();
    await expect(articleService.addFile(other.id, png("x.png"), f.revA.id)).rejects.toThrow(/not found/);
  });

  it("sends the files in force with the order mails: loose and the active revision's, never an older one's", async () => {
    const f = await makeDrawingArticle();
    expect((await articleService.filesWithData([f.article.id])).map((x) => x.filename).sort()).toEqual(["a.png", "lös.png"]);
  });
});

describe("revisionerna TO:n byggs efter", () => {
  it("snapshots the revisions at release, shows what changed since and prints the snapshot's file", async () => {
    const user = await makeUser();
    const f = await makeDrawingArticle();
    const order = await mfg.createManufacturingOrder({ articleId: f.article.id, quantity: 2 }, user.id);

    const view = await mfg.getOrderRevisions(order.id);
    expect(view.articleRevision).toBe("1");
    expect(view.snapshotAt).not.toBeNull();
    expect(view.drawings.map((d) => [d.drawingNumber, d.revision, d.file?.filename, d.changed])).toEqual([["R-1", "A", "a.png", false]]);
    expect(view.looseFiles.map((x) => x.filename)).toEqual(["lös.png"]);
    expect(view.changed).toBe(false);

    // A new active revision after release: the order keeps A, flags it.
    await articleService.updateDrawingRevision(f.article.id, f.drawing.id, f.revB.id, { isActive: true });
    await articleService.createDrawing(f.article.id, { drawingNumber: "R-2" });
    const changed = await mfg.getOrderRevisions(order.id);
    expect(changed.changed).toBe(true);
    expect(changed.drawings.map((d) => [d.drawingNumber, d.revision, d.current?.revision ?? null, d.changed, d.added])).toEqual([
      ["R-1", "A", "B", true, false],
      ["R-2", null, null, true, true],
    ]);
    const printedFiles = await articleService.drawingFilesWithData({ articleId: f.article.id, moId: order.id });
    expect(printedFiles.map((x) => x.filename)).toEqual(["a.png", "lös.png"]);

    // Uppdatera: today's revisions, logged.
    const refreshed = await mfg.refreshOrderRevisions(order.id, user.id);
    expect(refreshed.changed).toBe(false);
    expect(refreshed.drawings.map((d) => [d.drawingNumber, d.revision, d.file?.filename ?? null])).toEqual([
      ["R-1", "B", "b.png"],
      ["R-2", null, null],
    ]);
    expect((await articleService.drawingFilesWithData({ articleId: f.article.id, moId: order.id })).map((x) => x.filename)).toEqual([
      "b.png",
      "lös.png",
    ]);
    const [logged] = await db
      .select()
      .from(auditLog)
      .where(and(eq(auditLog.entityType, "manufacturing_order"), eq(auditLog.action, "revisions_updated")));
    expect(logged!.detail).toEqual({ before: "Revision 1 · Ritningar: R-1 rev A", after: "Revision 1 · Ritningar: R-1 rev B, R-2" });
  });

  it("refuses Uppdatera on an order that is not open", async () => {
    const user = await makeUser();
    const f = await makeDrawingArticle();
    const order = await mfg.createManufacturingOrder({ articleId: f.article.id, quantity: 2 }, user.id);
    await db.update(manufacturingOrders).set({ status: "done" }).where(eq(manufacturingOrders.id, order.id));
    await expect(mfg.refreshOrderRevisions(order.id, user.id)).rejects.toBeInstanceOf(ManufacturingOrderNotEditableError);
  });

  it("reads today's revisions for an order without a snapshot", async () => {
    const user = await makeUser();
    const f = await makeDrawingArticle();
    const order = await mfg.createManufacturingOrder({ articleId: f.article.id, quantity: 2 }, user.id);
    await db.update(manufacturingOrders).set({ revisionsSnapshotAt: null }).where(eq(manufacturingOrders.id, order.id));
    await articleService.updateDrawingRevision(f.article.id, f.drawing.id, f.revB.id, { isActive: true });
    const view = await mfg.getOrderRevisions(order.id);
    expect(view.snapshotAt).toBeNull();
    expect(view.drawings.map((d) => [d.revision, d.changed])).toEqual([["B", false]]);
    expect((await articleService.drawingFilesWithData({ articleId: f.article.id, moId: order.id })).map((x) => x.filename)).toEqual([
      "b.png",
      "lös.png",
    ]);
  });
});

describe("ritningar per operation", () => {
  async function withRouting() {
    const f = await makeDrawingArticle();
    const second = await articleService.createDrawing(f.article.id, { drawingNumber: "R-2-SVETS" });
    const revS = await articleService.createDrawingRevision(f.article.id, second.id, { revision: "1", isActive: false });
    await articleService.addFile(f.article.id, png("svets.png"), revS.id);
    const wc = await mfg.createWorkCenter(parsed(createWorkCenterSchema, { code: "100", name: "Svets", active: true }));
    const welding = await mfg.createRoutingOperation(
      f.article.id,
      parsed(createRoutingOperationSchema, { sequenceNo: 10, workCenterId: wc.id, setupTime: 5, runTimePerUnit: 1, drawingIds: [second.id] })
    );
    const assembly = await mfg.createRoutingOperation(
      f.article.id,
      parsed(createRoutingOperationSchema, { sequenceNo: 20, workCenterId: wc.id, setupTime: 5, runTimePerUnit: 1 })
    );
    return { ...f, second, welding, assembly, wc };
  }

  it("keeps the chosen drawings on the operation and refuses another article's", async () => {
    const f = await withRouting();
    expect(f.welding.drawings.map((d) => d.drawingNumber)).toEqual(["R-2-SVETS"]);
    const listed = await mfg.listRoutingOperations(f.article.id);
    expect(listed.map((op) => [op.sequenceNo, op.drawings.map((d) => d.drawingNumber)])).toEqual(
      expect.arrayContaining([
        [10, ["R-2-SVETS"]],
        [20, []],
      ])
    );
    const updated = await mfg.updateRoutingOperation(f.article.id, f.assembly.id, { drawingIds: [f.drawing.id, f.second.id] });
    expect(updated.drawings.map((d) => d.drawingNumber)).toEqual(["R-1", "R-2-SVETS"]);

    const other = await makeArticle();
    const foreign = await articleService.createDrawing(other.id, { drawingNumber: "X-1" });
    await expect(mfg.updateRoutingOperation(f.article.id, f.assembly.id, { drawingIds: [foreign.id] })).rejects.toBeInstanceOf(
      RoutingDrawingInvalidError
    );
  });

  it("gives an operation its chosen drawings only, otherwise all the order's and the loose files", async () => {
    const user = await makeUser();
    const f = await withRouting();
    const order = await mfg.createManufacturingOrder({ articleId: f.article.id, quantity: 3 }, user.id);
    const ops = await mfg.listOperations(order.id);
    const welding = ops.find((op) => op.sequenceNo === 10)!;
    const assembly = ops.find((op) => op.sequenceNo === 20)!;
    expect((await mfg.listOperationDrawingFiles(order.id, welding.id))!.map((x) => [x.drawingNumber, x.revision, x.filename])).toEqual([
      ["R-2-SVETS", "1", "svets.png"],
    ]);
    expect((await mfg.listOperationDrawingFiles(order.id, assembly.id))!.map((x) => x.filename)).toEqual([
      "a.png",
      "svets.png",
      "lös.png",
    ]);
    expect(await mfg.listOperationDrawingFiles(order.id, crypto.randomUUID())).toBeNull();
  });

  it("prints the revisions in the header, the drawing under its operation and the files at the end", async () => {
    const user = await makeUser();
    const f = await withRouting();
    const order = await mfg.createManufacturingOrder({ articleId: f.article.id, quantity: 3 }, user.id);
    const { content } = await mfg.getManufacturingOrderPdf(order.id);
    const text = pdfText(content);
    expect(text).toContain("Revision 1 · Ritningar: R-1 rev A, R-2-SVETS rev 1");
    expect(text).toContain("Ritning: R-2-SVETS rev 1");
    // The page itself, then a.png, svets.png and lös.png — never b.png.
    const { PDFDocument } = await import("pdf-lib");
    expect((await PDFDocument.load(content)).getPageCount()).toBe(4);
  });
});

describe("Kopiera från — ritningar och filer", () => {
  it("copies the loose and the active revisions' files as loose files, and the operations' drawings by number", async () => {
    const f = await makeDrawingArticle();
    const wc = await mfg.createWorkCenter(parsed(createWorkCenterSchema, { code: "100", name: "Svets", active: true }));
    await mfg.createRoutingOperation(
      f.article.id,
      parsed(createRoutingOperationSchema, { sequenceNo: 10, workCenterId: wc.id, setupTime: 5, runTimePerUnit: 1, drawingIds: [f.drawing.id] })
    );
    const copy = await articleService.createArticle(
      createArticleSchema.parse({
        articleNumber: `KOPIA-${crypto.randomUUID().slice(0, 8)}`,
        name: "Kopia",
        type: "manufactured",
        active: true,
        copyFrom: { articleId: f.article.id, parts: ["beredning", "filer"] },
      }) as CreateArticleInput
    );
    const files = await articleService.listFiles(copy.id);
    expect(files.map((x) => [x.filename, x.drawingRevisionId])).toEqual([
      ["a.png", null],
      ["lös.png", null],
    ]);
    const [drawing] = await articleService.listDrawings(copy.id);
    expect(drawing!.drawingNumber).toBe("R-1");
    expect(drawing!.revisions).toEqual([]);
    const [op] = await mfg.listRoutingOperations(copy.id);
    expect(op!.drawings).toEqual([{ id: drawing!.id, drawingNumber: "R-1" }]);
  });
});

import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { asc, eq, sql } from "drizzle-orm";
import { articleDrawingRevisions, articleDrawings, articleRevisions, articles, db } from "@navet/db";
import { createArticleRepository } from "../src/modules/article/repository/article.repository.js";
import { createArticleService } from "../src/modules/article/service/article.service.js";
import {
  planArticleImport,
  suggestArticleMapping,
  type ArticleImportDeps,
  type ExistingArticle,
} from "../src/modules/import/service/articles.js";
import { createImportService } from "../src/modules/import/service/import.service.js";
import { createImportRepository } from "../src/modules/import/repository/import.repository.js";
import { revisionChanges } from "../src/modules/import/repository/article-revisions.js";

// Artikelimporten's Revisioner columns: Artikelrevision becomes the article's
// active revision, Ritningsnummer is added to the article and Ritningsrevision
// becomes that drawing's active revision — additive and idempotent, never a
// removal.

const articleRepo = createArticleRepository(db);
const articleService = createArticleService(articleRepo);
const importRepo = createImportRepository(db);
const importService = createImportService(importRepo);

const TRUNCATE = sql`TRUNCATE bom_components, stock_transactions, articles, article_groups CASCADE`;

beforeEach(async () => {
  await db.execute(TRUNCATE);
});

afterAll(async () => {
  await db.execute(TRUNCATE);
});

const MAPPING = {
  Artikelnummer: "articleNumber",
  Benämning: "name",
  Artikelrevision: "articleRevision",
  Ritningsnummer: "drawingNumber",
  Ritningsrevision: "drawingRevision",
};

function fakeDeps(existing: ExistingArticle[] = []): ArticleImportDeps {
  return {
    async articlesByNumber(numbers) {
      return new Map(existing.filter((a) => numbers.includes(a.articleNumber)).map((a) => [a.articleNumber, a]));
    },
    async unitsByCode() {
      return new Map([["st", { id: "unit-st", code: "st" }]]);
    },
    async groupsByCode() {
      return new Map();
    },
    async resolveDefaults() {
      return { unitId: "unit-st", locationId: "loc-fallback" };
    },
  };
}

function existingArticle(activeRevision: string | null): ExistingArticle {
  return {
    id: "id-1",
    articleNumber: "A-1",
    name: "Diskbänk",
    type: "manufactured",
    unitCode: "st",
    unitId: "unit-st",
    isPhantom: false,
    groupCode: null,
    standardCost: null,
    weight: null,
    surfaceTreatment: null,
    colour: null,
    active: true,
    activeRevision,
  };
}

describe("suggestArticleMapping — revision headers", () => {
  it("recognises the template headings and common short forms", () => {
    expect(Object.values(suggestArticleMapping(["Artikelrevision", "Ritningsnummer", "Ritningsrevision"]))).toEqual([
      "articleRevision",
      "drawingNumber",
      "drawingRevision",
    ]);
    expect(Object.values(suggestArticleMapping(["Rev.", "Ritn.nr", "Ritn.rev"]))).toEqual([
      "articleRevision",
      "drawingNumber",
      "drawingRevision",
    ]);
  });
});

describe("planArticleImport — Revisioner", () => {
  it("stages all three on a new article", async () => {
    const plan = await planArticleImport({ mapping: MAPPING, rows: [["A-1", "Diskbänk", "B", "R-100", "C"]] }, fakeDeps());
    expect(plan.hasErrors).toBe(false);
    expect(plan.creates[0]!.revisions).toEqual({ articleRevision: "B", drawingNumber: "R-100", drawingRevision: "C" });
    expect(plan.rows[0]!.values).toMatchObject({ articleRevision: "B", drawingNumber: "R-100", drawingRevision: "C" });
  });

  it("stages nothing for empty cells", async () => {
    const plan = await planArticleImport({ mapping: MAPPING, rows: [["A-1", "Diskbänk", "", "", ""]] }, fakeDeps());
    expect(plan.creates[0]!.revisions).toBeUndefined();
  });

  it("refuses a drawing revision without a drawing number on the row, and over-long values", async () => {
    const plan = await planArticleImport(
      {
        mapping: MAPPING,
        rows: [
          ["A-1", "Diskbänk", "", "", "C"],
          ["A-2", "Diskbänk", "x".repeat(21), "y".repeat(51), "z".repeat(21)],
        ],
      },
      fakeDeps()
    );
    expect(plan.rows[0]!.errors).toEqual(["Ritningsrevision kräver ett ritningsnummer på samma rad"]);
    expect(plan.rows[1]!.errors).toEqual([
      "Artikelrevisionen är för lång (max 20 tecken)",
      "Ritningsnumret är för långt (max 50 tecken)",
      "Ritningsrevisionen är för lång (max 20 tecken)",
    ]);
  });

  it("on an existing article: warns when the active revision changes, stages nothing when it is already active", async () => {
    const change = await planArticleImport(
      { mapping: MAPPING, rows: [["A-1", "", "B", "", ""]] },
      fakeDeps([existingArticle("A")])
    );
    expect(change.rows[0]!.warnings).toEqual(["Aktiv artikelrevision byts från A till B"]);
    expect(change.updates[0]!.revisions).toEqual({ articleRevision: "B", drawingNumber: null, drawingRevision: null });

    const same = await planArticleImport(
      { mapping: MAPPING, rows: [["A-1", "", "A", "", ""]] },
      fakeDeps([existingArticle("A")])
    );
    expect(same.rows[0]!.warnings).toEqual([]);
    expect(same.updates[0]!.revisions).toBeUndefined();

    // No active revision yet: nothing to warn about.
    const first = await planArticleImport(
      { mapping: MAPPING, rows: [["A-1", "", "A", "", ""]] },
      fakeDeps([existingArticle(null)])
    );
    expect(first.rows[0]!.warnings).toEqual([]);
    expect(first.updates[0]!.revisions?.articleRevision).toBe("A");
  });
});

describe("revisionChanges", () => {
  const row = (id: string, ownerId: string, revision: string, isActive: boolean) => ({ id, ownerId, revision, isActive });

  it("adds a missing revision and switches the old active one off", () => {
    expect(revisionChanges([row("r1", "a", "A", true)], new Map([["a", "B"]]))).toEqual({
      deactivate: ["r1"],
      activate: [],
      insert: [{ ownerId: "a", revision: "B" }],
    });
  });

  it("activates an existing inactive revision, leaves an active one alone", () => {
    const existing = [row("r1", "a", "A", true), row("r2", "a", "B", false), row("r3", "b", "C", true)];
    expect(revisionChanges(existing, new Map([["a", "B"], ["b", "C"]]))).toEqual({
      deactivate: ["r1"],
      activate: ["r2"],
      insert: [],
    });
  });
});

async function revisionsOf(articleNumber: string) {
  const [article] = await db.select({ id: articles.id }).from(articles).where(eq(articles.articleNumber, articleNumber));
  const revisions = await db
    .select({ revision: articleRevisions.revision, isActive: articleRevisions.isActive })
    .from(articleRevisions)
    .where(eq(articleRevisions.articleId, article!.id))
    .orderBy(asc(articleRevisions.revision));
  const drawings = await db
    .select({ id: articleDrawings.id, drawingNumber: articleDrawings.drawingNumber })
    .from(articleDrawings)
    .where(eq(articleDrawings.articleId, article!.id))
    .orderBy(asc(articleDrawings.drawingNumber));
  const withRevisions = [];
  for (const drawing of drawings) {
    const rows = await db
      .select({ revision: articleDrawingRevisions.revision, isActive: articleDrawingRevisions.isActive })
      .from(articleDrawingRevisions)
      .where(eq(articleDrawingRevisions.drawingId, drawing.id))
      .orderBy(asc(articleDrawingRevisions.revision));
    withRevisions.push({ drawingNumber: drawing.drawingNumber, revisions: rows });
  }
  return { revisions, drawings: withRevisions };
}

describe("import service — Revisioner committed", () => {
  it("creates the registers on new articles and changes them additively on existing ones", async () => {
    // An existing article with revision A and drawing R-1 (rev 1) from the card.
    const existing = await articleService.createArticle({
      articleNumber: "REV-1",
      name: "Finns redan",
      type: "manufactured",
      isPhantom: false,
      active: true,
    });
    await articleRepo.createRevision(existing.id, { revision: "A", isActive: false });
    const drawing = await articleRepo.createDrawing(existing.id, { drawingNumber: "R-1" });
    await articleRepo.createDrawingRevision(drawing.id, { revision: "1", isActive: false });

    const preview = await importService.preview("articles", {
      mapping: MAPPING,
      rows: [
        ["REV-1", "", "B", "R-2", "3"],
        ["REV-2", "Ny", "A", "R-9", ""],
      ],
    });
    expect(preview.rows[0]!.warnings).toEqual(["Aktiv artikelrevision byts från A till B"]);

    const result = await importService.commit("articles", {
      mapping: MAPPING,
      rows: [
        ["REV-1", "", "B", "R-2", "3"],
        ["REV-2", "Ny", "A", "R-9", ""],
      ],
    });
    expect(result).toMatchObject({ created: 1, updated: 1 });

    expect(await revisionsOf("REV-1")).toEqual({
      revisions: [
        { revision: "A", isActive: false },
        { revision: "B", isActive: true },
      ],
      drawings: [
        { drawingNumber: "R-1", revisions: [{ revision: "1", isActive: true }] },
        { drawingNumber: "R-2", revisions: [{ revision: "3", isActive: true }] },
      ],
    });
    expect(await revisionsOf("REV-2")).toEqual({
      revisions: [{ revision: "A", isActive: true }],
      drawings: [{ drawingNumber: "R-9", revisions: [] }],
    });

    // Back to an earlier revision: the existing rows are re-activated, never duplicated.
    await importService.commit("articles", { mapping: MAPPING, rows: [["REV-1", "", "A", "R-1", "1"]] });
    await importService.commit("articles", { mapping: MAPPING, rows: [["REV-1", "", "A", "R-1", "1"]] });
    expect(await revisionsOf("REV-1")).toEqual({
      revisions: [
        { revision: "A", isActive: true },
        { revision: "B", isActive: false },
      ],
      drawings: [
        { drawingNumber: "R-1", revisions: [{ revision: "1", isActive: true }] },
        { drawingNumber: "R-2", revisions: [{ revision: "3", isActive: true }] },
      ],
    });

    // A new revision on an existing drawing: the old one stays, inactive.
    await importService.commit("articles", { mapping: MAPPING, rows: [["REV-1", "", "", "R-1", "2"]] });
    expect((await revisionsOf("REV-1")).drawings[0]).toEqual({
      drawingNumber: "R-1",
      revisions: [
        { revision: "1", isActive: false },
        { revision: "2", isActive: true },
      ],
    });
  });

  it("reads the active revision for the preview (articlesByNumber)", async () => {
    const article = await articleService.createArticle({
      articleNumber: "REV-3",
      name: "Uppslag",
      type: "purchased",
      isPhantom: false,
      active: true,
    });
    expect((await importRepo.articlesByNumber(["REV-3"])).get("REV-3")!.activeRevision).toBeNull();
    await articleRepo.createRevision(article.id, { revision: "A", isActive: false });
    await articleRepo.createRevision(article.id, { revision: "B", isActive: true });
    expect((await importRepo.articlesByNumber(["REV-3"])).get("REV-3")!.activeRevision).toBe("B");
  });
});

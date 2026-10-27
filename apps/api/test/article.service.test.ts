import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import { articleCodes, db, units } from "@navet/db";
import { createArticleSchema, updateArticleSchema, createArticleGroupSchema, updateArticleGroupSchema } from "@navet/shared";
import { createArticleRepository } from "../src/modules/article/repository/article.repository.js";
import {
  createArticleService,
  BomCycleError,
  ArticleNotFoundError,
  BomComponentNotFoundError,
  DuplicateArticleGroupError,
  DuplicateArticleNumberError,
  DuplicateBomComponentError,
  InvalidReferenceError,
} from "../src/modules/article/service/article.service.js";

const repo = createArticleRepository(db);
const service = createArticleService(repo);

async function makeArticle(articleNumber: string) {
  return service.createArticle({
    articleNumber,
    name: articleNumber,
    type: "purchased",
    unit: "st",
    active: true,
  });
}

beforeEach(async () => {
  await db.execute(sql`TRUNCATE bom_components, stock_transactions, articles, article_groups, article_codes CASCADE`);
});

afterAll(async () => {
  await db.execute(sql`TRUNCATE bom_components, stock_transactions, articles, article_groups, article_codes CASCADE`);
});

describe("article service — BOM structure", () => {
  it("stores, updates and clears a row's Pos.", async () => {
    const parent = await makeArticle("PARENT-POS");
    const child = await makeArticle("CHILD-POS");
    const row = await service.addBomComponent(parent.id, { componentArticleId: child.id, quantity: 1, position: "12" });
    expect((await service.getBom(parent.id))[0]?.position).toBe("12");
    await service.updateBomComponent(parent.id, row!.id, { position: "12a" });
    expect((await service.getBom(parent.id))[0]?.position).toBe("12a");
    await service.updateBomComponent(parent.id, row!.id, { position: null });
    expect((await service.getBom(parent.id))[0]?.position).toBeNull();
  });

  it("adds a direct component to a parent article", async () => {
    const parent = await makeArticle("PARENT-1");
    const child = await makeArticle("CHILD-1");

    await service.addBomComponent(parent.id, { componentArticleId: child.id, quantity: 2 });

    const bom = await service.getBom(parent.id);
    expect(bom).toHaveLength(1);
    expect(bom[0]?.componentArticleId).toBe(child.id);
    expect(bom[0]?.quantity).toBe("2.0000");
  });

  it("rejects a direct self-reference at the service layer", async () => {
    const article = await makeArticle("SELF-1");

    await expect(
      service.addBomComponent(article.id, { componentArticleId: article.id, quantity: 1 })
    ).rejects.toThrow(BomCycleError);
  });

  it("rejects an indirect cycle (A -> B -> C, then C -> A)", async () => {
    const a = await makeArticle("A");
    const b = await makeArticle("B");
    const c = await makeArticle("C");

    await service.addBomComponent(a.id, { componentArticleId: b.id, quantity: 1 });
    await service.addBomComponent(b.id, { componentArticleId: c.id, quantity: 1 });

    await expect(
      service.addBomComponent(c.id, { componentArticleId: a.id, quantity: 1 })
    ).rejects.toThrow(BomCycleError);
  });

  it("allows the same component to be reused under different, non-cyclical parents", async () => {
    const parentOne = await makeArticle("PARENT-A");
    const parentTwo = await makeArticle("PARENT-B");
    const sharedChild = await makeArticle("SHARED-CHILD");

    await service.addBomComponent(parentOne.id, { componentArticleId: sharedChild.id, quantity: 1 });
    await service.addBomComponent(parentTwo.id, { componentArticleId: sharedChild.id, quantity: 1 });

    expect(await service.getBom(parentOne.id)).toHaveLength(1);
    expect(await service.getBom(parentTwo.id)).toHaveLength(1);
  });

  it("rejects the same component twice on one article", async () => {
    // bom_components is unique on (parent, component) — the operation link is
    // chosen per component, not per routing row. Without the service catching
    // the violation this surfaced to the client as a raw 500.
    const parent = await makeArticle("DUP-PARENT");
    const child = await makeArticle("DUP-CHILD");

    await service.addBomComponent(parent.id, { componentArticleId: child.id, quantity: 1 });

    await expect(
      service.addBomComponent(parent.id, { componentArticleId: child.id, quantity: 5 })
    ).rejects.toBeInstanceOf(DuplicateBomComponentError);

    // The first row is untouched — a refused duplicate must not have rewritten it.
    const bom = await service.getBom(parent.id);
    expect(bom).toHaveLength(1);
    expect(bom[0]?.quantity).toBe("1.0000");
  });

  it("throws ArticleNotFoundError when the parent or component does not exist", async () => {
    const existing = await makeArticle("EXISTS-1");
    const fakeId = "00000000-0000-0000-0000-000000000000";

    await expect(
      service.addBomComponent(fakeId, { componentArticleId: existing.id, quantity: 1 })
    ).rejects.toThrow(ArticleNotFoundError);

    await expect(
      service.addBomComponent(existing.id, { componentArticleId: fakeId, quantity: 1 })
    ).rejects.toThrow(ArticleNotFoundError);
  });
});

describe("article service — BOM tree", () => {
  it("returns the nested structure with quantities and bomRowIds", async () => {
    const a = await makeArticle("TREE-A");
    const b = await makeArticle("TREE-B");
    const c = await makeArticle("TREE-C");

    const abRow = await service.addBomComponent(a.id, { componentArticleId: b.id, quantity: 2 });
    await service.addBomComponent(b.id, { componentArticleId: c.id, quantity: 3 });

    const tree = await service.getBomTree(a.id);

    expect(tree.articleId).toBe(a.id);
    expect(tree.quantity).toBeNull();
    expect(tree.bomRowId).toBeNull();
    expect(tree.children).toHaveLength(1);

    const nodeB = tree.children[0]!;
    expect(nodeB.articleId).toBe(b.id);
    expect(Number(nodeB.quantity)).toBe(2);
    expect(nodeB.bomRowId).toBe(abRow!.id);
    expect(nodeB.children).toHaveLength(1);

    const nodeC = nodeB.children[0]!;
    expect(nodeC.articleId).toBe(c.id);
    expect(Number(nodeC.quantity)).toBe(3);
    expect(nodeC.children).toHaveLength(0);
  });

  it("keeps phantom articles as their own nodes (unlike explosion)", async () => {
    const parent = await makeArticle("TREE-P");
    const phantom = await service.createArticle({
      articleNumber: "TREE-PH",
      name: "Fantom",
      type: "manufactured",
      isPhantom: true,
      unit: "st",
      active: true,
    });
    const leaf = await makeArticle("TREE-LEAF");

    await service.addBomComponent(parent.id, { componentArticleId: phantom.id, quantity: 1 });
    await service.addBomComponent(phantom.id, { componentArticleId: leaf.id, quantity: 4 });

    const tree = await service.getBomTree(parent.id);
    const phantomNode = tree.children[0]!;
    expect(phantomNode.articleId).toBe(phantom.id);
    expect(phantomNode.isPhantom).toBe(true);
    expect(phantomNode.children).toHaveLength(1);
    expect(phantomNode.children[0]!.articleId).toBe(leaf.id);
  });

  it("throws ArticleNotFoundError for a missing article", async () => {
    const fakeId = "00000000-0000-0000-0000-000000000000";
    await expect(service.getBomTree(fakeId)).rejects.toThrow(ArticleNotFoundError);
  });
});

describe("article service — general update", () => {
  it("updates name, unit, and active", async () => {
    const article = await makeArticle("UPDATE-1");
    const [kg] = await db.insert(units).values({ code: "kg", name: "Kilogram" }).onConflictDoNothing().returning();
    const kgId = kg?.id ?? (await db.select().from(units).where(sql`code = 'kg'`))[0]!.id;

    const updated = await service.updateArticle(article.id, { name: "Nytt namn", unitId: kgId, active: false });

    expect(updated?.name).toBe("Nytt namn");
    expect(updated?.unit).toBe("kg");
    expect(updated?.active).toBe(false);
    expect(updated?.articleNumber).toBe("UPDATE-1"); // unchanged, not editable here
  });

  it("throws ArticleNotFoundError for a missing article", async () => {
    const fakeId = "00000000-0000-0000-0000-000000000000";
    await expect(service.updateArticle(fakeId, { name: "X" })).rejects.toThrow(ArticleNotFoundError);
  });

  it("takes the varugrupp's VAT rate: 25 % without a group, the group's rate with one, following a change", async () => {
    const created = await service.createArticle({
      articleNumber: `VAT-${crypto.randomUUID().slice(0, 8)}`,
      name: "Momsartikel",
      type: "purchased",
    });
    expect(created.vatRate).toBe("25.00");
    const group = await service.createArticleGroup({ code: "7", name: `Livsmedel ${crypto.randomUUID()}`, vatRate: 12 });
    expect(group.vatRate).toBe("12.00");
    const updated = await service.updateArticle(created.id, { groupId: group.id });
    expect(updated!.vatRate).toBe("12.00");
    // The rate lives on the group only: changing it moves every article along.
    await service.updateArticleGroup(group.id, { code: "7", name: group.name, vatRate: 6 });
    expect((await service.getArticle(created.id))!.vatRate).toBe("6.00");
    // A single-digit code is a valid varugrupp code since 0155; 5 digits is not.
    await expect(service.createArticleGroup({ code: "12345", name: "För lång" } as never)).rejects.toThrow();
  });

  it("stores the artikelkod, filters the list on it and refuses an unknown one", async () => {
    const [code] = await db.insert(articleCodes).values({ code: "100", name: "Plåt" }).returning();
    const created = await service.createArticle({
      articleNumber: `AK-${crypto.randomUUID().slice(0, 8)}`,
      name: "Kodad",
      type: "purchased",
      articleCodeId: code!.id,
    });
    expect(created).toMatchObject({ articleCodeId: code!.id, articleCodeCode: "100", articleCodeName: "Plåt" });
    await service.createArticle({ articleNumber: `AK-${crypto.randomUUID().slice(0, 8)}`, name: "Okodad", type: "purchased" });
    const list = await service.listArticles({ articleCodeId: code!.id, limit: 50, offset: 0 });
    expect(list.rows.map((r) => r.id)).toEqual([created.id]);
    expect(list.rows[0]).toMatchObject({ articleCodeName: "Plåt", vatRate: "25.00" });
    await expect(
      service.createArticle({ articleNumber: "AK-X", name: "X", type: "purchased", articleCodeId: crypto.randomUUID() })
    ).rejects.toThrow(InvalidReferenceError);
    const cleared = await service.updateArticle(created.id, { articleCodeId: null });
    expect(cleared!.articleCodeId).toBeNull();
  });

  it("stores salesPrice on create, updates and clears it via update", async () => {
    const created = await service.createArticle({
      articleNumber: `SP-${crypto.randomUUID().slice(0, 8)}`,
      name: "Prisartikel",
      type: "purchased",
      salesPrice: 199.5,
    });
    expect(created.salesPrice).toBe("199.5000");

    const updated = await service.updateArticle(created.id, { salesPrice: 249.9 });
    expect(updated!.salesPrice).toBe("249.9000");

    const untouched = await service.updateArticle(created.id, { name: "Prisartikel 2" });
    expect(untouched!.salesPrice).toBe("249.9000");

    const cleared = await service.updateArticle(created.id, { salesPrice: null });
    expect(cleared!.salesPrice).toBeNull();
  });

  it("stores the planning fields (reorder point + order quantity), null clears them", async () => {
    const created = await service.createArticle({
      articleNumber: `PLAN-${crypto.randomUUID().slice(0, 8)}`,
      name: "Planartikel",
      type: "purchased",
      reorderPoint: 25,
      orderQuantity: 10,
    });
    expect(created.reorderPoint).toBe("25.0000");
    expect(created.orderQuantity).toBe("10.0000");

    const updated = await service.updateArticle(created.id, { reorderPoint: 40.5 });
    expect(updated!.reorderPoint).toBe("40.5000");
    expect(updated!.orderQuantity).toBe("10.0000");

    const cleared = await service.updateArticle(created.id, { reorderPoint: null, orderQuantity: null });
    expect(cleared!.reorderPoint).toBeNull();
    expect(cleared!.orderQuantity).toBeNull();
  });

  it("stores Avrundning with 3 decimals, null clears it", async () => {
    const created = await service.createArticle({
      articleNumber: `RND-${crypto.randomUUID().slice(0, 8)}`,
      name: "Rundad",
      type: "purchased",
      rounding: 7.38,
    });
    expect(created.rounding).toBe("7.380");

    const updated = await service.updateArticle(created.id, { rounding: 0.125 });
    expect(updated!.rounding).toBe("0.125");

    const cleared = await service.updateArticle(created.id, { rounding: null });
    expect(cleared!.rounding).toBeNull();
  });

  it("validates Avrundning in the shared schemas: positive, at most 3 decimals, null clears on update", () => {
    const base = { articleNumber: "RND-Z", name: "Rundad", type: "purchased" as const };
    expect(createArticleSchema.safeParse({ ...base, rounding: 5 }).success).toBe(true);
    expect(createArticleSchema.safeParse({ ...base, rounding: "7.38" }).success).toBe(true);
    expect(createArticleSchema.safeParse({ ...base, rounding: 0 }).success).toBe(false);
    expect(createArticleSchema.safeParse({ ...base, rounding: -1 }).success).toBe(false);
    expect(createArticleSchema.safeParse({ ...base, rounding: 0.0001 }).success).toBe(false);
    expect(createArticleSchema.safeParse({ ...base, rounding: 28.86000111 }).success).toBe(false);
    expect(updateArticleSchema.safeParse({ rounding: null }).success).toBe(true);
    expect(updateArticleSchema.safeParse({ rounding: 0 }).success).toBe(false);
  });
});

describe("article service — full editability", () => {
  it("edits article number and type, rejecting duplicates", async () => {
    const a = await makeArticle("EDIT-1");
    await makeArticle("EDIT-2");

    const updated = await service.updateArticle(a.id, { articleNumber: "EDIT-99", type: "manufactured" });
    expect(updated!.articleNumber).toBe("EDIT-99");
    expect(updated!.type).toBe("manufactured");

    await expect(service.updateArticle(a.id, { articleNumber: "EDIT-2" })).rejects.toBeInstanceOf(
      DuplicateArticleNumberError
    );
  });

  it("updates and removes BOM rows, scoped to the parent article", async () => {
    const parent = await makeArticle("BOM-P");
    const other = await makeArticle("BOM-O");
    const child = await makeArticle("BOM-C");
    const row = await service.addBomComponent(parent.id, { componentArticleId: child.id, quantity: 2 });

    const updated = await service.updateBomComponent(parent.id, row!.id, { quantity: 5 });
    expect(updated.quantity).toBe("5.0000");

    // A row id under the wrong parent must 404, not mutate.
    await expect(service.updateBomComponent(other.id, row!.id, { quantity: 1 })).rejects.toBeInstanceOf(
      BomComponentNotFoundError
    );

    await service.removeBomComponent(parent.id, row!.id);
    expect(await service.getBom(parent.id)).toHaveLength(0);
    await expect(service.removeBomComponent(parent.id, row!.id)).rejects.toBeInstanceOf(BomComponentNotFoundError);
  });

  it("renames an article group", async () => {
    const group = await service.createArticleGroup({ code: "310", name: "Grupp A" });
    const renamed = await service.updateArticleGroup(group.id, { code: "310", name: "Grupp B" });
    expect(renamed.name).toBe("Grupp B");
  });
});

describe("article service — article group codes", () => {
  it("creates a group with a 3-digit code", async () => {
    const group = await service.createArticleGroup({ code: "310", name: "Diskbänkar 60cm" });
    expect(group.code).toBe("310");
  });

  it("creates a group with a 4-digit code", async () => {
    const group = await service.createArticleGroup({ code: "3100", name: "Diskbänkar 80cm" });
    expect(group.code).toBe("3100");
  });

  it("rejects a duplicate code", async () => {
    await service.createArticleGroup({ code: "310", name: "Grupp A" });
    await expect(service.createArticleGroup({ code: "310", name: "Grupp B" })).rejects.toThrow(
      DuplicateArticleGroupError
    );
  });

  it("rejects a duplicate name", async () => {
    await service.createArticleGroup({ code: "310", name: "Grupp A" });
    await expect(service.createArticleGroup({ code: "320", name: "Grupp A" })).rejects.toThrow(
      DuplicateArticleGroupError
    );
  });

  it("updates the code", async () => {
    const group = await service.createArticleGroup({ code: "310", name: "Grupp A" });
    const updated = await service.updateArticleGroup(group.id, { code: "320", name: "Grupp A" });
    expect(updated.code).toBe("320");
  });

  it("allows saving a group with its own unchanged code and name", async () => {
    const group = await service.createArticleGroup({ code: "310", name: "Grupp A" });
    const updated = await service.updateArticleGroup(group.id, { code: "310", name: "Grupp A" });
    expect(updated.id).toBe(group.id);
  });

  it("rejects a code change that collides with another group", async () => {
    await service.createArticleGroup({ code: "310", name: "Grupp A" });
    const other = await service.createArticleGroup({ code: "320", name: "Grupp B" });
    await expect(service.updateArticleGroup(other.id, { code: "310", name: "Grupp B" })).rejects.toThrow(
      DuplicateArticleGroupError
    );
  });

  it("lists groups sorted by code", async () => {
    await service.createArticleGroup({ code: "320", name: "B" });
    await service.createArticleGroup({ code: "100", name: "C" });
    await service.createArticleGroup({ code: "310", name: "A" });

    const list = await service.listArticleGroups();
    expect(list.map((g) => g.code)).toEqual(["100", "310", "320"]);
  });
});

describe("article service — list search/filter/pagination", () => {
  async function seedArticles() {
    const group = await service.createArticleGroup({ code: "310", name: "Rostfritt" });
    await service.createArticle({
      articleNumber: "DB-100",
      name: "Diskbänk 60cm",
      type: "manufactured",
      unit: "st",
      active: true,
      groupId: group.id,
    });
    await service.createArticle({
      articleNumber: "DB-200",
      name: "Diskbänk 80cm",
      type: "manufactured",
      unit: "st",
      active: true,
    });
    await service.createArticle({ articleNumber: "SKRUV-1", name: "Skruv M6", type: "purchased", unit: "st", active: true });
    return { group };
  }

  it("searches case-insensitively on article number and name", async () => {
    await seedArticles();

    const byName = await service.listArticles({ search: "diskbänk", limit: 50, offset: 0 });
    expect(byName.total).toBe(2);
    expect(byName.rows.map((a) => a.articleNumber)).toEqual(["DB-100", "DB-200"]);

    const byNumber = await service.listArticles({ search: "skruv-1", limit: 50, offset: 0 });
    expect(byNumber.total).toBe(1);
    expect(byNumber.rows[0]?.name).toBe("Skruv M6");
  });

  it("treats ILIKE wildcards in the search term as literals", async () => {
    await seedArticles();
    const result = await service.listArticles({ search: "%", limit: 50, offset: 0 });
    expect(result.total).toBe(0);
  });

  it("filters by type and group", async () => {
    const { group } = await seedArticles();

    const purchased = await service.listArticles({ type: "purchased", limit: 50, offset: 0 });
    expect(purchased.total).toBe(1);
    expect(purchased.rows[0]?.articleNumber).toBe("SKRUV-1");

    const grouped = await service.listArticles({ groupId: group.id, limit: 50, offset: 0 });
    expect(grouped.total).toBe(1);
    expect(grouped.rows[0]?.articleNumber).toBe("DB-100");
    expect(grouped.rows[0]?.groupName).toBe("Rostfritt");
  });

  it("paginates ordered by article number with the full total", async () => {
    await seedArticles();

    const firstPage = await service.listArticles({ limit: 2, offset: 0 });
    expect(firstPage.total).toBe(3);
    expect(firstPage.rows.map((a) => a.articleNumber)).toEqual(["DB-100", "DB-200"]);

    const secondPage = await service.listArticles({ limit: 2, offset: 2 });
    expect(secondPage.total).toBe(3);
    expect(secondPage.rows.map((a) => a.articleNumber)).toEqual(["SKRUV-1"]);
  });
});

describe("article service — revisions & drawings", () => {
  it("auto-activates the first article revision and switches on activation", async () => {
    const article = await makeArticle("REV-1");

    const a = await service.createRevision(article.id, { revision: "A", comment: "Första utgåvan", isActive: false });
    expect(a.isActive).toBe(true); // first one becomes active despite isActive: false
    expect(a.comment).toBe("Första utgåvan");

    const b = await service.createRevision(article.id, { revision: "B", isActive: false });
    expect(b.isActive).toBe(false);

    // Activate B — A flips off, never two active at once.
    await service.updateRevision(article.id, b.id, { isActive: true });
    const list = await service.listRevisions(article.id);
    expect(list.filter((r) => r.isActive).map((r) => r.revision)).toEqual(["B"]);

    // Creating with isActive: true also switches.
    const c = await service.createRevision(article.id, { revision: "C", isActive: true });
    expect(c.isActive).toBe(true);
    expect((await service.listRevisions(article.id)).filter((r) => r.isActive)).toHaveLength(1);
  });

  it("rejects duplicate revisions, edits comments and leaves none active after deleting the active one", async () => {
    const article = await makeArticle("REV-2");
    const a = await service.createRevision(article.id, { revision: "A", isActive: false });

    const { DuplicateRevisionError, ArticleRevisionNotFoundError } = await import(
      "../src/modules/article/service/article.service.js"
    );
    await expect(service.createRevision(article.id, { revision: "A", isActive: false })).rejects.toThrow(
      DuplicateRevisionError
    );

    const updated = await service.updateRevision(article.id, a.id, { comment: "Ny kommentar" });
    expect(updated.comment).toBe("Ny kommentar");

    await service.deleteRevision(article.id, a.id);
    expect(await service.listRevisions(article.id)).toHaveLength(0);
    await expect(service.deleteRevision(article.id, a.id)).rejects.toThrow(ArticleRevisionNotFoundError);
  });

  it("manages drawings with their own revision registers", async () => {
    const article = await makeArticle("RIT-1");
    const drawing = await service.createDrawing(article.id, { drawingNumber: "4711" });

    const { DuplicateDrawingNumberError } = await import("../src/modules/article/service/article.service.js");
    await expect(service.createDrawing(article.id, { drawingNumber: "4711" })).rejects.toThrow(
      DuplicateDrawingNumberError
    );
    // The same number on another article is fine (uniqueness is per article).
    const other = await makeArticle("RIT-2");
    await service.createDrawing(other.id, { drawingNumber: "4711" });

    const a = await service.createDrawingRevision(article.id, drawing.id, { revision: "A", isActive: false });
    expect(a.isActive).toBe(true); // first is auto-active
    const b = await service.createDrawingRevision(article.id, drawing.id, {
      revision: "B",
      comment: "Nytt hålmönster",
      isActive: true,
    });
    expect(b.isActive).toBe(true);

    const drawings = await service.listDrawings(article.id);
    expect(drawings).toHaveLength(1);
    expect(drawings[0]!.revisions).toHaveLength(2);
    expect(drawings[0]!.revisions.filter((r) => r.isActive).map((r) => r.revision)).toEqual(["B"]);

    // Deleting the drawing cascades its revisions.
    await service.deleteDrawing(article.id, drawing.id);
    expect(await service.listDrawings(article.id)).toHaveLength(0);
  });

  it("summarizes active revision info per article for document printing", async () => {
    const article = await makeArticle("INFO-1");
    await service.createRevision(article.id, { revision: "B", isActive: false });
    const d1 = await service.createDrawing(article.id, { drawingNumber: "4711" });
    await service.createDrawingRevision(article.id, d1.id, { revision: "C", isActive: false });
    // A drawing without revisions still shows its number.
    await service.createDrawing(article.id, { drawingNumber: "4712" });

    const info = (await service.activeRevisionInfo([article.id])).get(article.id);
    expect(info).toEqual({
      revision: "B",
      drawings: [
        { drawingNumber: "4711", revision: "C" },
        { drawingNumber: "4712", revision: null },
      ],
    });
  });
});

describe("article group description", () => {
  it("round-trips a description through create, update and list", async () => {
    const input = createArticleGroupSchema.parse({ code: "310", name: "Grupp A", description: "  Underrede  " });
    const group = await service.createArticleGroup(input);
    expect(group.description).toBe("Underrede");

    const updated = await service.updateArticleGroup(
      group.id,
      updateArticleGroupSchema.parse({ code: "310", name: "Grupp A", description: "Överskåp" })
    );
    expect(updated.description).toBe("Överskåp");

    const listed = await service.listArticleGroups();
    expect(listed.find((g) => g.id === group.id)?.description).toBe("Överskåp");
  });

  it("stores a blank description as null and keeps it when omitted on update", async () => {
    const group = await service.createArticleGroup(
      createArticleGroupSchema.parse({ code: "320", name: "Grupp B", description: "   " })
    );
    expect(group.description).toBeNull();

    const withText = await service.updateArticleGroup(
      group.id,
      updateArticleGroupSchema.parse({ code: "320", name: "Grupp B", description: "Text" })
    );
    const kept = await service.updateArticleGroup(group.id, updateArticleGroupSchema.parse({ code: "320", name: "Grupp B" }));
    expect(withText.description).toBe("Text");
    expect(kept.description).toBe("Text");

    const cleared = await service.updateArticleGroup(
      group.id,
      updateArticleGroupSchema.parse({ code: "320", name: "Grupp B", description: "" })
    );
    expect(cleared.description).toBeNull();
  });

  it("rejects a description over 500 characters (400 via the route's zod parse)", () => {
    expect(createArticleGroupSchema.safeParse({ code: "310", name: "A", description: "x".repeat(500) }).success).toBe(true);
    expect(createArticleGroupSchema.safeParse({ code: "310", name: "A", description: "x".repeat(501) }).success).toBe(false);
    expect(updateArticleGroupSchema.safeParse({ code: "310", name: "A", description: "x".repeat(501) }).success).toBe(false);
  });
});

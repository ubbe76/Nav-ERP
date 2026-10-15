import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import { db, units } from "@navet/db";
import { createArticleRepository } from "../src/modules/article/repository/article.repository.js";
import {
  createArticleService,
  ArticleUnitInUseError,
  ArticleUnitNotFoundError,
  BaseUnitConflictError,
  BaseUnitLockedError,
  DuplicateArticleUnitError,
  InvalidUnitError,
} from "../src/modules/article/service/article.service.js";

const repo = createArticleRepository(db);
const service = createArticleService(repo);

let stId: string;
let kgId: string;
let mId: string;

beforeEach(async () => {
  await db.execute(sql`TRUNCATE article_units, bom_components, stock_transactions, articles, units CASCADE`);
  const rows = await db
    .insert(units)
    .values([
      { code: "st", name: "Styck" },
      { code: "kg", name: "Kilogram" },
      { code: "m", name: "Meter" },
    ])
    .returning();
  stId = rows.find((r) => r.code === "st")!.id;
  kgId = rows.find((r) => r.code === "kg")!.id;
  mId = rows.find((r) => r.code === "m")!.id;
});

afterAll(async () => {
  await db.execute(sql`TRUNCATE article_units, bom_components, stock_transactions, articles, units CASCADE`);
});

async function makeArticle(articleNumber: string, unitId?: string) {
  return service.createArticle({
    articleNumber,
    name: articleNumber,
    type: "purchased",
    isPhantom: false,
    unitId,
    active: true,
  });
}

describe("article service — base unit", () => {
  it("defaults a new article to the st unit, creating it if missing", async () => {
    await db.execute(sql`TRUNCATE article_units, articles, units CASCADE`);
    const article = await makeArticle("ART-1");
    const found = await service.getArticle(article.id);
    expect(found?.unit).toBe("st");
    expect(found?.unitId).toBeTruthy();
  });

  it("creates an article with an explicit base unit", async () => {
    const article = await makeArticle("ART-KG", kgId);
    const found = await service.getArticle(article.id);
    expect(found?.unit).toBe("kg");
    expect(found?.unitId).toBe(kgId);
  });
});

describe("article service — alternative units", () => {
  it("adds, lists, updates and removes an alternative unit", async () => {
    const article = await makeArticle("ALT-1", stId);

    const row = await service.addArticleUnit(article.id, { unitId: kgId, quantityPerBase: 5 });
    expect(row.unitId).toBe(kgId);

    const listed = await service.listArticleUnits(article.id);
    expect(listed).toHaveLength(1);
    expect(listed[0]?.unitCode).toBe("kg");
    expect(Number(listed[0]?.quantityPerBase)).toBe(5);

    await service.updateArticleUnit(article.id, row.id, { quantityPerBase: 4 });
    expect(Number((await service.listArticleUnits(article.id))[0]?.quantityPerBase)).toBe(4);

    await service.removeArticleUnit(article.id, row.id);
    expect(await service.listArticleUnits(article.id)).toHaveLength(0);
  });

  it("rejects the base unit as an alternative unit", async () => {
    const article = await makeArticle("ALT-2", stId);
    await expect(service.addArticleUnit(article.id, { unitId: stId, quantityPerBase: 5 })).rejects.toThrow(
      BaseUnitConflictError
    );
  });

  it("rejects a duplicate alternative unit", async () => {
    const article = await makeArticle("ALT-3", stId);
    await service.addArticleUnit(article.id, { unitId: kgId, quantityPerBase: 5 });
    await expect(service.addArticleUnit(article.id, { unitId: kgId, quantityPerBase: 2 })).rejects.toThrow(
      DuplicateArticleUnitError
    );
  });

  it("404s on a unit row belonging to another article", async () => {
    const a = await makeArticle("ALT-4A", stId);
    const b = await makeArticle("ALT-4B", stId);
    const row = await service.addArticleUnit(a.id, { unitId: kgId, quantityPerBase: 5 });
    await expect(service.updateArticleUnit(b.id, row.id, { quantityPerBase: 2 })).rejects.toThrow(
      ArticleUnitNotFoundError
    );
  });
});

describe("article service — base unit lock and default units", () => {
  it("blocks changing the base unit while alternative units exist", async () => {
    const article = await makeArticle("LOCK-1", stId);
    const row = await service.addArticleUnit(article.id, { unitId: kgId, quantityPerBase: 5 });

    await expect(service.updateArticle(article.id, { unitId: mId })).rejects.toThrow(BaseUnitLockedError);

    await service.removeArticleUnit(article.id, row.id);
    const updated = await service.updateArticle(article.id, { unitId: mId });
    expect(updated?.unitId).toBe(mId);
  });

  it("accepts the base unit or an alternative unit as purchase/sales unit, rejects others", async () => {
    const article = await makeArticle("DEF-1", stId);
    await service.addArticleUnit(article.id, { unitId: kgId, quantityPerBase: 5 });

    const updated = await service.updateArticle(article.id, { purchaseUnitId: kgId, salesUnitId: stId });
    expect(updated?.purchaseUnitId).toBe(kgId);
    expect(updated?.salesUnitId).toBe(stId);

    await expect(service.updateArticle(article.id, { purchaseUnitId: mId })).rejects.toThrow(InvalidUnitError);

    // Clearing goes back to "base unit".
    const cleared = await service.updateArticle(article.id, { purchaseUnitId: null });
    expect(cleared?.purchaseUnitId).toBeNull();
  });

  it("blocks removing an alternative unit that is the purchase or sales unit", async () => {
    const article = await makeArticle("DEF-2", stId);
    const row = await service.addArticleUnit(article.id, { unitId: kgId, quantityPerBase: 5 });
    await service.updateArticle(article.id, { purchaseUnitId: kgId });

    await expect(service.removeArticleUnit(article.id, row.id)).rejects.toThrow(ArticleUnitInUseError);
  });
});

describe("article service — BOM rows in alternative units", () => {
  it("stores base-unit quantity and snapshots the factor when a row is entered in an alternative unit", async () => {
    const parent = await makeArticle("BOM-P", stId);
    const component = await makeArticle("BOM-C", stId);
    await service.addArticleUnit(component.id, { unitId: kgId, quantityPerBase: 5 });

    await service.addBomComponent(parent.id, {
      componentArticleId: component.id,
      quantity: 500,
      unitId: kgId,
    });

    const bom = await service.getBom(parent.id);
    expect(bom[0]?.quantity).toBe("100.0000");
    expect(bom[0]?.unitCode).toBe("kg");
    expect(Number(bom[0]?.unitFactor)).toBe(5);
  });

  it("interprets a quantity PATCH in the row's unit and can switch back to the base unit", async () => {
    const parent = await makeArticle("BOM-P2", stId);
    const component = await makeArticle("BOM-C2", stId);
    await service.addArticleUnit(component.id, { unitId: kgId, quantityPerBase: 5 });
    await service.addBomComponent(parent.id, { componentArticleId: component.id, quantity: 500, unitId: kgId });
    const row = (await service.getBom(parent.id))[0]!;

    await service.updateBomComponent(parent.id, row.id, { quantity: 250 });
    expect((await service.getBom(parent.id))[0]?.quantity).toBe("50.0000");

    await service.updateBomComponent(parent.id, row.id, { quantity: 10, unitId: null });
    const after = (await service.getBom(parent.id))[0];
    expect(after?.quantity).toBe("10.0000");
    expect(after?.unitCode).toBe("st");
    expect(after?.unitFactor).toBeNull();
  });

  it("rejects a unit the component article does not have", async () => {
    const parent = await makeArticle("BOM-P3", stId);
    const component = await makeArticle("BOM-C3", stId);

    await expect(
      service.addBomComponent(parent.id, { componentArticleId: component.id, quantity: 1, unitId: kgId })
    ).rejects.toThrow(InvalidUnitError);
  });
});

describe("article service — weight & dimensions", () => {
  it("stores and clears weight (kg) and dimensions (mm)", async () => {
    const article = await makeArticle("WD-1", stId);

    await service.updateArticle(article.id, { weight: 12.5, length: 100, width: 50, height: 20.5 });
    let found = await service.getArticle(article.id);
    expect(Number(found?.weight)).toBe(12.5);
    expect(Number(found?.length)).toBe(100);
    expect(Number(found?.width)).toBe(50);
    expect(Number(found?.height)).toBe(20.5);

    // null clears the value; omitted fields are untouched.
    await service.updateArticle(article.id, { weight: null, length: null });
    found = await service.getArticle(article.id);
    expect(found?.weight).toBeNull();
    expect(found?.length).toBeNull();
    expect(Number(found?.width)).toBe(50);
    expect(Number(found?.height)).toBe(20.5);
  });
});

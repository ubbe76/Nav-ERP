import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import { db } from "@navet/db";
import { createArticleRepository } from "../src/modules/article/repository/article.repository.js";
import { createArticleService } from "../src/modules/article/service/article.service.js";
import { createRegisterRepository } from "../src/modules/register/repository/register.repository.js";
import { createRegisterService } from "../src/modules/register/service/register.service.js";

const articleService = createArticleService(createArticleRepository(db));
const registerService = createRegisterService(createRegisterRepository(db));

// package_types is referenced by articles (restrict) — CASCADE handles order.
const TRUNCATE = sql`TRUNCATE article_units, bom_components, stock_transactions, articles, package_types, units CASCADE`;

beforeEach(async () => {
  await db.execute(TRUNCATE);
});

afterAll(async () => {
  await db.execute(TRUNCATE);
});

async function makeArticle(articleNumber: string) {
  return articleService.createArticle({ articleNumber, name: articleNumber, type: "purchased", active: true });
}

describe("article packaging (antal per kolli + kollityp)", () => {
  it("stores quantity per package and the package type, joined by name", async () => {
    const pkg = await registerService.packageTypes.create({ code: "EUR", name: "EUR-pall" });
    const article = await makeArticle("PKG-1");

    await articleService.updateArticle(article.id, { quantityPerPackage: 48, packageTypeId: pkg.id });
    const found = await articleService.getArticle(article.id);
    expect(Number(found?.quantityPerPackage)).toBe(48);
    expect(found?.packageTypeId).toBe(pkg.id);
    expect(found?.packageTypeCode).toBe("EUR");
    expect(found?.packageTypeName).toBe("EUR-pall");
  });

  it("clears the package fields with null", async () => {
    const pkg = await registerService.packageTypes.create({ code: "KRT", name: "Kartong" });
    const article = await makeArticle("PKG-2");
    await articleService.updateArticle(article.id, { quantityPerPackage: 10, packageTypeId: pkg.id });

    await articleService.updateArticle(article.id, { quantityPerPackage: null, packageTypeId: null });
    const found = await articleService.getArticle(article.id);
    expect(found?.quantityPerPackage).toBeNull();
    expect(found?.packageTypeId).toBeNull();
    expect(found?.packageTypeName).toBeNull();
  });

  it("seeds the standard kollityper idempotently", async () => {
    const first = await registerService.seedStandardPackageTypes();
    expect(first.created).toBeGreaterThan(0);
    const list = await registerService.packageTypes.list();
    expect(list.some((p) => p.name === "EUR-pall")).toBe(true);

    const second = await registerService.seedStandardPackageTypes();
    expect(second.created).toBe(0); // already present
  });
});

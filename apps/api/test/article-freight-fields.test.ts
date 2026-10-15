import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import { db } from "@navet/db";
import { createArticleRepository } from "../src/modules/article/repository/article.repository.js";
import { createArticleService } from "../src/modules/article/service/article.service.js";
import { createRegisterRepository } from "../src/modules/register/repository/register.repository.js";
import { createRegisterService } from "../src/modules/register/service/register.service.js";

const articleService = createArticleService(createArticleRepository(db));
const registerService = createRegisterService(createRegisterRepository(db));

const TRUNCATE = sql`TRUNCATE article_units, bom_components, stock_transactions, articles, package_types, units CASCADE`;
beforeEach(async () => {
  await db.execute(TRUNCATE);
});
afterAll(async () => {
  await db.execute(TRUNCATE);
});

describe("artikelns fraktfält (egna mått)", () => {
  it("derives flakmeter from pallplatser on create", async () => {
    const a = await articleService.createArticle({
      articleNumber: "FR-A1",
      name: "Diskbänk 3 m",
      type: "manufactured",
      active: true,
      parcelKind: "pallet",
      palletSpaces: 2,
    });
    const found = await articleService.getArticle(a!.id);
    expect(found?.parcelKind).toBe("pallet");
    expect(Number(found?.palletSpaces)).toBe(2);
    expect(Number(found?.loadingMeters)).toBe(0.8);
  });

  it("an explicit flakmeter wins over pallplatser", async () => {
    const a = await articleService.createArticle({
      articleNumber: "FR-A2",
      name: "Bänk",
      type: "manufactured",
      active: true,
      palletSpaces: 2,
      loadingMeters: 1.5,
    });
    expect(Number((await articleService.getArticle(a!.id))?.loadingMeters)).toBe(1.5);
  });

  it("derives on update when only pallplatser changes and flakmeter is empty", async () => {
    const a = await articleService.createArticle({ articleNumber: "FR-A3", name: "Bänk", type: "manufactured", active: true });
    await articleService.updateArticle(a!.id, { palletSpaces: 3, stackable: true });
    const found = await articleService.getArticle(a!.id);
    expect(Number(found?.loadingMeters)).toBe(1.2);
    expect(found?.stackable).toBe(true);
  });

  it("keeps a stored flakmeter when pallplatser changes", async () => {
    const a = await articleService.createArticle({
      articleNumber: "FR-A4",
      name: "Bänk",
      type: "manufactured",
      active: true,
      loadingMeters: 2,
    });
    await articleService.updateArticle(a!.id, { palletSpaces: 1 });
    expect(Number((await articleService.getArticle(a!.id))?.loadingMeters)).toBe(2);
  });
});

describe("kollitypens fraktfält", () => {
  it("updates the freight set of a package type", async () => {
    const pkg = await registerService.packageTypes.create({ code: "KRT", name: "Kartong" });
    const updated = await registerService.updatePackageTypeFreight(pkg.id, {
      parcelKind: "package",
      lengthMm: 600,
      widthMm: 400,
      heightMm: 300,
      tareWeight: 0.5,
      stackable: true,
      loadingMeters: null,
    });
    expect(updated.parcelKind).toBe("package");
    expect(Number(updated.lengthMm)).toBe(600);
    expect(Number(updated.tareWeight)).toBe(0.5);
    expect(updated.stackable).toBe(true);
    expect(updated.loadingMeters).toBeNull();
  });

  it("seeds the standard pallets with footprint and tare weight", async () => {
    await registerService.seedStandardPackageTypes();
    const eur = (await registerService.packageTypes.list()).find((p) => p.code === "EUR");
    expect(eur?.parcelKind).toBe("pallet");
    expect(Number(eur?.lengthMm)).toBe(1200);
    expect(Number(eur?.widthMm)).toBe(800);
    expect(Number(eur?.tareWeight)).toBe(25);
  });
});

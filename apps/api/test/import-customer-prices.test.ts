import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { eq, sql } from "drizzle-orm";
import { articles as articlesTable, customerArticleNumbers, customerPrices, customers, db, units } from "@navet/db";
import { importEntitySchema } from "@navet/shared";
import { createImportRepository } from "../src/modules/import/repository/import.repository.js";
import { createImportService } from "../src/modules/import/service/import.service.js";
import type { ExistingArticle } from "../src/modules/import/service/articles.js";
import {
  planCustomerPriceImport,
  suggestCustomerPriceMapping,
  type CustomerPriceImportDeps,
} from "../src/modules/import/service/customer-prices.js";

// Monitor's "Prislista Försäljning" headings, in file order.
const MONITOR_HEADERS = [
  "Artikelnummer",
  "Artikelbenämning",
  "Artikeltyp",
  "Artikelkod",
  "Kund",
  "Namn",
  "Kundens art.nummer",
  "Pris",
  "Ställpris",
  "Rabatt",
  "Prisdatum",
];

const MAPPING: Record<string, string | null> = {
  Artikelnummer: "articleNumber",
  Kund: "customerNumber",
  Pris: "price",
  Rabatt: "discountPercent",
};

function article(articleNumber: string, id: string): ExistingArticle {
  return {
    id,
    articleNumber,
    name: articleNumber,
    type: "purchased",
    unitCode: "st",
    unitId: "unit-st",
    isPhantom: false,
    groupCode: null,
    standardCost: null,
    weight: null,
    surfaceTreatment: null,
    colour: null,
    active: true,
  };
}

function fakeDeps(
  articles: ExistingArticle[] = [],
  customerNumbers: string[] = ["6252", "1132"],
  existing: { customerNumber: string; articleId: string; id: string }[] = [],
  existingNumbers: { customerNumber: string; articleId: string; number: string }[] = []
): CustomerPriceImportDeps {
  return {
    async articlesByNumber(numbers) {
      return new Map(articles.filter((a) => numbers.includes(a.articleNumber)).map((a) => [a.articleNumber, a]));
    },
    async customersByNumber(numbers) {
      return new Map(customerNumbers.filter((n) => numbers.includes(n)).map((n) => [n, { id: `cust-${n}` }]));
    },
    async customerArticlePrices() {
      return new Map(existing.map((e) => [`cust-${e.customerNumber}#${e.articleId}`, { id: e.id }]));
    },
    async customerArticleNumbers() {
      return new Map(existingNumbers.map((e) => [`cust-${e.customerNumber}#${e.articleId}`, e.number]));
    },
  };
}

describe("suggestCustomerPriceMapping", () => {
  it("maps Monitor's Prislista Försäljning, Kundens art.nummer included, leaving Ställpris/Prisdatum alone", () => {
    expect(suggestCustomerPriceMapping(MONITOR_HEADERS)).toEqual({
      Artikelnummer: "articleNumber",
      Artikelbenämning: null,
      Artikeltyp: null,
      Artikelkod: null,
      Kund: "customerNumber",
      Namn: null,
      "Kundens art.nummer": "customerArticleNumber",
      Pris: "price",
      Ställpris: null,
      Rabatt: "discountPercent",
      Prisdatum: null,
    });
  });
});

describe("planCustomerPriceImport", () => {
  it("plans article prices at antal 1 with the discount baked in", async () => {
    const plan = await planCustomerPriceImport(
      {
        mapping: MAPPING,
        rows: [
          ["FRP5X36", "6252", "3,52", "25"],
          ["M6M4", "1132", "0,2", ""],
        ],
      },
      fakeDeps([article("FRP5X36", "id-1"), article("M6M4", "id-2")])
    );
    expect(plan.hasErrors).toBe(false);
    expect(plan.rows[0]!.warnings).toEqual(["Rabatten 25 % är inbakad i priset"]);
    expect(plan.rows[1]!.warnings).toEqual([]);
    expect(plan.summary).toEqual({ create: 2, update: 0, skip: 0, error: 0, warning: 1 });
    expect(plan.creates).toEqual([
      { customerId: "cust-6252", articleId: "id-1", unitPrice: 2.64 },
      { customerId: "cust-1132", articleId: "id-2", unitPrice: 0.2 },
    ]);
  });

  it("updates an existing rule, or skips it with skipExisting", async () => {
    const deps = fakeDeps([article("A", "id-1")], ["6252"], [{ customerNumber: "6252", articleId: "id-1", id: "rule-1" }]);
    const update = await planCustomerPriceImport({ mapping: MAPPING, rows: [["A", "6252", "10", ""]] }, deps);
    expect(update.rows[0]!.action).toBe("update");
    expect(update.updates).toEqual([{ id: "rule-1", unitPrice: 10 }]);

    const skip = await planCustomerPriceImport({ mapping: MAPPING, rows: [["A", "6252", "10", ""]], skipExisting: true }, deps);
    expect(skip.rows[0]).toMatchObject({ action: "skip", skipReason: "Kunden 6252 har redan en koppling till artikel A" });
  });

  it("errors on unknown customers/articles, bad discounts and in-file duplicates; skips a row without price", async () => {
    const plan = await planCustomerPriceImport(
      {
        mapping: MAPPING,
        rows: [
          ["SAKNAS", "6252", "1", ""],
          ["A", "9999", "1", ""],
          ["B", "6252", "", ""],
          ["C", "6252", "1", "100"],
          ["D", "6252", "x", ""],
          ["A", "6252", "1", ""],
          ["A", "6252", "2", ""],
        ],
      },
      fakeDeps([article("A", "id-1"), article("B", "id-2"), article("C", "id-3"), article("D", "id-4")])
    );
    expect(plan.rows.map((row) => row.errors)).toEqual([
      ["Artikeln SAKNAS finns inte i artikelregistret"],
      ["Kunden 9999 finns inte i kundregistret"],
      [],
      ["Rabatten måste vara mellan 0 och 100 procent"],
      ['Ogiltigt pris: "x"'],
      [],
      ["Kundpriset för 6252 / A förekommer flera gånger i filen"],
    ]);
    expect(plan.rows[2]).toMatchObject({ action: "skip", skipReason: "Varken pris eller kundens artikelnummer på raden" });
  });

  it("requires the article and customer columns, not the price", async () => {
    await expect(
      planCustomerPriceImport({ mapping: { Artikelnummer: "articleNumber", Pris: "price" }, rows: [] }, fakeDeps())
    ).rejects.toThrow(/customerNumber/);
    await expect(
      planCustomerPriceImport({ mapping: { Artikelnummer: "articleNumber", Kund: "customerNumber" }, rows: [] }, fakeDeps())
    ).resolves.toMatchObject({ hasErrors: false });
  });

  // Monitor's "Artikellista, Kundkopplingar": every article, most without a
  // customer, some with only the customer's article number.
  it("reads Kundkopplingar: skips rows without a customer, stores the customer's article number", async () => {
    const mapping = { ...MAPPING, "Kundens art.nr": "customerArticleNumber" };
    const plan = await planCustomerPriceImport(
      {
        mapping,
        rows: [
          ["A", "", "", "", ""],
          ["B", "6252", "", "", "KND-2"],
          ["C", "6252", "15", "", "KND-3"],
          ["D", "6252", "", "10", ""],
          ["A", "6252", "", "", "x".repeat(51)],
        ],
      },
      fakeDeps(
        [article("A", "id-1"), article("B", "id-2"), article("C", "id-3"), article("D", "id-4")],
        ["6252"],
        [],
        [{ customerNumber: "6252", articleId: "id-3", number: "KND-3" }]
      )
    );
    expect(plan.rows[0]).toMatchObject({ action: "skip", skipReason: "Ingen kundkoppling på raden" });
    expect(plan.rows[1]).toMatchObject({ action: "create", errors: [] });
    // C's number is already stored — only the price is written.
    expect(plan.rows[2]).toMatchObject({ action: "update", errors: [] });
    expect(plan.rows[3]).toMatchObject({ action: "skip" });
    expect(plan.rows[4]!.errors).toEqual(["Kundens artikelnummer är för långt (51 tecken, max 50)"]);
    expect(plan.creates).toEqual([{ customerId: "cust-6252", articleId: "id-3", unitPrice: 15 }]);
    expect(plan.articleNumbers).toEqual([{ customerId: "cust-6252", articleId: "id-2", customerArticleNumber: "KND-2" }]);
  });
});

// --- Database ---

const repo = createImportRepository(db);
const importService = createImportService(repo);

const TRUNCATE = sql`TRUNCATE customer_prices, bom_components, articles, customers CASCADE`;

beforeEach(async () => {
  await db.execute(TRUNCATE);
});

afterAll(async () => {
  await db.execute(TRUNCATE);
});

async function seedArticle(articleNumber: string) {
  await db.insert(units).values({ code: "st", name: "Styck" }).onConflictDoNothing();
  const [unit] = await db.select({ id: units.id }).from(units).where(eq(units.code, "st"));
  const [row] = await db
    .insert(articlesTable)
    .values({ articleNumber, name: articleNumber, type: "purchased", unitId: unit!.id })
    .returning({ id: articlesTable.id });
  return row!.id;
}

async function seedCustomer(customerNumber: string) {
  const [row] = await db
    .insert(customers)
    .values({ customerNumber, name: `Kund ${customerNumber}` })
    .returning({ id: customers.id });
  return row!.id;
}

describe("customer price import — repository and service", () => {
  it("accepts customerPrices in the entity enum", () => {
    expect(importEntitySchema.options).toContain("customerPrices");
  });

  it("creates article rules and turns an existing discount rule into a price on update", async () => {
    const articleId = await seedArticle("A");
    const customerId = await seedCustomer("6252");
    await db.insert(customerPrices).values({ customerId, articleId, fromQuantity: "1", discountPercent: "15" });

    const result = await importService.commit("customerPrices", {
      mapping: MAPPING,
      rows: [["A", "6252", "3,52", "25"]],
    });
    expect(result).toMatchObject({ created: 0, updated: 1 });
    const [rule] = await db.select().from(customerPrices).where(eq(customerPrices.customerId, customerId));
    // unit_price XOR discount_percent — the update clears the discount.
    expect(rule).toMatchObject({ unitPrice: "2.6400", discountPercent: null, fromQuantity: "1.0000" });

    const second = await importService.commit("customerPrices", {
      mapping: MAPPING,
      rows: [["A", "6252", "4", ""]],
      skipExisting: true,
    });
    expect(second).toMatchObject({ created: 0, updated: 0, skipped: 1 });
  });
});

describe("customer price import — Kundens artikelnummer end to end", () => {
  it("upserts the customer's article number without a price, and replaces it on re-import", async () => {
    const articleId = await seedArticle("ART-1");
    const customerId = await seedCustomer("6252");
    const mapping = { Artikelnummer: "articleNumber", Kund: "customerNumber", Pris: "price", "Kundens art.nr": "customerArticleNumber" };
    const first = await importService.commit("customerPrices", { mapping, rows: [["ART-1", "6252", "", "KND-1"]] });
    expect(first).toMatchObject({ created: 1, updated: 0 });
    await importService.commit("customerPrices", { mapping, rows: [["ART-1", "6252", "", "KND-1B"]] });
    const stored = await db.select().from(customerArticleNumbers);
    expect(stored).toMatchObject([{ customerId, articleId, customerArticleNumber: "KND-1B" }]);
    expect(await db.select().from(customerPrices)).toHaveLength(0);
  });
});

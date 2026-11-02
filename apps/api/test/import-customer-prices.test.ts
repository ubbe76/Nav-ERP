import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { eq, sql } from "drizzle-orm";
import { articles as articlesTable, customerArticleNumbers, customerPrices, customers, db, units } from "@navet/db";
import { importEntitySchema } from "@navet/shared";
import { createImportRepository } from "../src/modules/import/repository/import.repository.js";
import { createImportService } from "../src/modules/import/service/import.service.js";
import { resolvePrice } from "../src/modules/sales/service/price-resolver.js";
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
  existing: { customerNumber: string; articleId: string; id: string; setupPrice?: number | null }[] = [],
  existingNumbers: { customerNumber: string; articleId: string; number: string }[] = [],
  existingBreaks: { customerNumber: string; articleId: string; fromQuantity: number; id: string }[] = []
): CustomerPriceImportDeps {
  return {
    async articlesByNumber(numbers) {
      return new Map(articles.filter((a) => numbers.includes(a.articleNumber)).map((a) => [a.articleNumber, a]));
    },
    async customersByNumber(numbers) {
      return new Map(customerNumbers.filter((n) => numbers.includes(n)).map((n) => [n, { id: `cust-${n}` }]));
    },
    async customerArticlePrices() {
      return new Map(
        existing.map((e) => [
          `cust-${e.customerNumber}#${e.articleId}`,
          e.setupPrice !== undefined ? { id: e.id, setupPrice: e.setupPrice } : { id: e.id },
        ])
      );
    },
    async customerArticlePriceBreaks() {
      const map = new Map<string, Map<number, { id: string }>>();
      for (const e of existingBreaks) {
        const key = `cust-${e.customerNumber}#${e.articleId}`;
        if (!map.has(key)) map.set(key, new Map());
        map.get(key)!.set(e.fromQuantity, { id: e.id });
      }
      return map;
    },
    async customerArticleNumbers() {
      return new Map(existingNumbers.map((e) => [`cust-${e.customerNumber}#${e.articleId}`, e.number]));
    },
  };
}

describe("suggestCustomerPriceMapping", () => {
  it("maps Monitor's Prislista Försäljning, Kundens art.nummer and Ställpris included, leaving Prisdatum alone", () => {
    expect(suggestCustomerPriceMapping(MONITOR_HEADERS)).toEqual({
      Artikelnummer: "articleNumber",
      Artikelbenämning: null,
      Artikeltyp: null,
      Artikelkod: null,
      Kund: "customerNumber",
      Namn: null,
      "Kundens art.nummer": "customerArticleNumber",
      Pris: "price",
      Ställpris: "setupPrice",
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

describe("customer price import — Ställpris", () => {
  it("stores it on the price rule, 0 meaning none, skipped with a warning without a price", async () => {
    const mapping = { ...MAPPING, Ställpris: "setupPrice" };
    const plan = await planCustomerPriceImport(
      {
        mapping,
        rows: [
          ["A", "6252", "100", "", "400"],
          ["B", "6252", "100", "", "0"],
          ["C", "6252", "", "", "250"],
          ["D", "6252", "100", "", "-1"],
        ],
      },
      fakeDeps([article("A", "id-1"), article("B", "id-2"), article("C", "id-3"), article("D", "id-4")])
    );
    expect(plan.creates).toEqual([
      { customerId: "cust-6252", articleId: "id-1", unitPrice: 100, setupPrice: 400 },
      { customerId: "cust-6252", articleId: "id-2", unitPrice: 100, setupPrice: null },
    ]);
    expect(plan.rows[2]).toMatchObject({ action: "skip" });
    expect(plan.rows[3]!.errors).toEqual(["Ställpriset kan inte vara negativt"]);
  });

  it("commits the ställpris and leaves it alone when the cell is empty", async () => {
    await seedArticle("ART-1");
    await seedCustomer("6252");
    const mapping = { Artikelnummer: "articleNumber", Kund: "customerNumber", Pris: "price", Ställpris: "setupPrice" };
    await importService.commit("customerPrices", { mapping, rows: [["ART-1", "6252", "100", "400"]] });
    await importService.commit("customerPrices", { mapping, rows: [["ART-1", "6252", "120", ""]] });
    const [rule] = await db.select().from(customerPrices);
    expect(rule).toMatchObject({ unitPrice: "120.0000", setupPrice: "400.0000" });
  });
});


// --- Staffel (Prislista Försäljning, Stafflade) ---

// The stafflade export's headings, in file order.
const STAFFEL_HEADERS = [
  "Kund",
  "Namn",
  "Artikelnummer",
  "Artikelbenämning",
  "Kundens art.nummer",
  "Pris",
  "Ställpris",
  "Rabatt",
  "Prisdatum",
  "Gränsvärde antal",
  "Pris (staffling)",
];

// Kund, Artikelnummer, Pris, Ställpris, Rabatt, Gränsvärde, Staffelpris.
const STAFFEL_MAPPING: Record<string, string | null> = {
  Kund: "customerNumber",
  Artikelnummer: "articleNumber",
  Pris: "price",
  Ställpris: "setupPrice",
  Rabatt: "discountPercent",
  "Gränsvärde antal": "breakQuantity",
  "Pris (staffling)": "breakPrice",
};

describe("customer price import — staffel mapping", () => {
  it("maps the stafflade export and the template's Staffel headings", () => {
    expect(suggestCustomerPriceMapping(STAFFEL_HEADERS)).toEqual({
      Kund: "customerNumber",
      Namn: null,
      Artikelnummer: "articleNumber",
      Artikelbenämning: null,
      "Kundens art.nummer": "customerArticleNumber",
      Pris: "price",
      Ställpris: "setupPrice",
      Rabatt: "discountPercent",
      Prisdatum: null,
      "Gränsvärde antal": "breakQuantity",
      "Pris (staffling)": "breakPrice",
    });
    expect(suggestCustomerPriceMapping(["Artikelnummer", "Kundnummer", "Pris", "Staffel: från antal", "Staffel: pris"])).toMatchObject({
      "Staffel: från antal": "breakQuantity",
      "Staffel: pris": "breakPrice",
    });
    // A second "Pris" column is the step price, like the supplier side.
    expect(suggestCustomerPriceMapping(["Artikelnummer", "Kund", "Pris", "Gränsvärde antal", "Pris (2)"])).toMatchObject({
      Pris: "price",
      "Pris (2)": "breakPrice",
    });
  });
});

describe("planCustomerPriceImport — staffel", () => {
  const arts = [article("A", "id-a"), article("B", "id-b"), article("C", "id-c"), article("D", "id-d")];

  it("groups a pair's step rows: Pris at antal 1, a rule per step, Ställpris on every step", async () => {
    const plan = await planCustomerPriceImport(
      {
        mapping: STAFFEL_MAPPING,
        rows: [
          ["6252", "A", "1200", "400", "", "20", "300"],
          ["6252", "A", "1200", "400", "", "50", "250"],
          ["6252", "A", "1200", "400", "", "100", "230"],
        ],
      },
      fakeDeps(arts)
    );
    expect(plan.hasErrors).toBe(false);
    expect(plan.summary).toEqual({ create: 3, update: 0, skip: 0, error: 0, warning: 0 });
    expect(plan.creates).toEqual([
      { customerId: "cust-6252", articleId: "id-a", unitPrice: 1200, setupPrice: 400 },
      { customerId: "cust-6252", articleId: "id-a", fromQuantity: 20, unitPrice: 300, setupPrice: 400 },
      { customerId: "cust-6252", articleId: "id-a", fromQuantity: 50, unitPrice: 250, setupPrice: 400 },
      { customerId: "cust-6252", articleId: "id-a", fromQuantity: 100, unitPrice: 230, setupPrice: 400 },
    ]);
    expect(plan.deletes).toEqual([]);
  });

  it("takes a Gränsvärde 1 step as the antal-1 price, over Pris and with a warning when they differ", async () => {
    const plan = await planCustomerPriceImport(
      {
        mapping: STAFFEL_MAPPING,
        rows: [
          ["6252", "A", "", "", "", "1", "500"],
          ["6252", "A", "", "", "", "10", "400"],
          ["6252", "B", "900", "", "", "1", "950"],
          ["6252", "B", "900", "", "", "5", "800"],
          ["6252", "C", "700", "", "", "1", "700"],
        ],
      },
      fakeDeps(arts)
    );
    expect(plan.hasErrors).toBe(false);
    expect(plan.rows.map((row) => row.warnings)).toEqual([
      [],
      [],
      ["Staffelpriset 950 vid antal 1 gäller i stället för Pris 900"],
      [],
      [],
    ]);
    expect(plan.creates).toEqual([
      { customerId: "cust-6252", articleId: "id-a", unitPrice: 500 },
      { customerId: "cust-6252", articleId: "id-a", fromQuantity: 10, unitPrice: 400 },
      { customerId: "cust-6252", articleId: "id-b", unitPrice: 950 },
      { customerId: "cust-6252", articleId: "id-b", fromQuantity: 5, unitPrice: 800 },
      { customerId: "cust-6252", articleId: "id-c", unitPrice: 700 },
    ]);
  });

  it("reads Pris 0 with steps as no own price below the first step and deletes a stored antal-1 rule", async () => {
    const plan = await planCustomerPriceImport(
      {
        mapping: STAFFEL_MAPPING,
        rows: [
          ["6252", "A", "0", "", "", "100", "40"],
          ["6252", "A", "0", "", "", "250", "35"],
          ["6252", "B", "0", "", "", "10", "90"],
          // Pris 0 without steps is a real 0 kr price, as in the plain list.
          ["6252", "C", "0", "", "", "", ""],
        ],
      },
      fakeDeps(arts, ["6252"], [{ customerNumber: "6252", articleId: "id-a", id: "base-a" }])
    );
    expect(plan.hasErrors).toBe(false);
    expect(plan.rows[0]!.warnings).toEqual([
      "Pris 0 med staffel betyder inget eget pris under första steget — kundpriset från antal 1 tas bort",
    ]);
    expect(plan.rows[2]!.warnings).toEqual(["Pris 0 med staffel betyder inget eget pris under första steget"]);
    expect(plan.deletes).toEqual(["base-a"]);
    expect(plan.updates).toEqual([]);
    expect(plan.creates).toEqual([
      { customerId: "cust-6252", articleId: "id-a", fromQuantity: 100, unitPrice: 40 },
      { customerId: "cust-6252", articleId: "id-a", fromQuantity: 250, unitPrice: 35 },
      { customerId: "cust-6252", articleId: "id-b", fromQuantity: 10, unitPrice: 90 },
      { customerId: "cust-6252", articleId: "id-c", unitPrice: 0 },
    ]);
  });

  it("replaces a pair's stored steps as a set; a row without Gränsvärde clears them; steps inherit the stored ställpris", async () => {
    const plan = await planCustomerPriceImport(
      {
        mapping: STAFFEL_MAPPING,
        rows: [
          ["6252", "A", "100", "", "", "10", "90"],
          ["6252", "A", "100", "", "", "20", "80"],
          ["6252", "B", "50", "", "", "", ""],
        ],
      },
      fakeDeps(
        arts,
        ["6252"],
        [{ customerNumber: "6252", articleId: "id-a", id: "base-a", setupPrice: 250 }],
        [],
        [
          { customerNumber: "6252", articleId: "id-a", fromQuantity: 10, id: "step-a10" },
          { customerNumber: "6252", articleId: "id-a", fromQuantity: 30, id: "step-a30" },
          { customerNumber: "6252", articleId: "id-b", fromQuantity: 5, id: "step-b5" },
        ]
      )
    );
    expect(plan.hasErrors).toBe(false);
    expect(plan.rows.map((row) => row.action)).toEqual(["update", "update", "update"]);
    // An empty Ställpris cell leaves the stored rules' ställpris alone; the
    // NEW step takes the antal-1 rule's.
    expect(plan.updates).toEqual([
      { id: "base-a", unitPrice: 100 },
      { id: "step-a10", unitPrice: 90 },
    ]);
    expect(plan.creates).toEqual([
      { customerId: "cust-6252", articleId: "id-a", fromQuantity: 20, unitPrice: 80, setupPrice: 250 },
      { customerId: "cust-6252", articleId: "id-b", unitPrice: 50 },
    ]);
    expect(plan.deletes).toEqual(["step-a30", "step-b5"]);
  });

  it("bakes Rabatt into the step price too", async () => {
    const plan = await planCustomerPriceImport(
      { mapping: STAFFEL_MAPPING, rows: [["6252", "A", "100", "", "10", "20", "90"]] },
      fakeDeps(arts)
    );
    expect(plan.rows[0]!.warnings).toEqual(["Rabatten 10 % är inbakad i priset"]);
    expect(plan.creates).toEqual([
      { customerId: "cust-6252", articleId: "id-a", unitPrice: 90 },
      { customerId: "cust-6252", articleId: "id-a", fromQuantity: 20, unitPrice: 81 },
    ]);
  });

  it("errors on repeated steps, a step without price, a bad Gränsvärde and a repeated plain row", async () => {
    const plan = await planCustomerPriceImport(
      {
        mapping: STAFFEL_MAPPING,
        rows: [
          ["6252", "A", "100", "", "", "10", "90"],
          ["6252", "A", "100", "", "", "10", "85"],
          ["6252", "B", "100", "", "", "10", ""],
          ["6252", "C", "100", "", "", "x", "5"],
          ["6252", "D", "100", "", "", "", ""],
          ["6252", "D", "100", "", "", "", ""],
        ],
      },
      fakeDeps(arts)
    );
    expect(plan.rows.map((row) => row.errors)).toEqual([
      [],
      ["Gränsvärdet 10 förekommer flera gånger för kund 6252 och artikel A"],
      ["Staffelpris saknas för gränsvärdet 10"],
      ['Ogiltigt gränsvärde: "x"'],
      [],
      ["Kundpriset för 6252 / D förekommer flera gånger i filen"],
    ]);
    expect(plan.hasErrors).toBe(true);
  });

  it("skips every row of a pair that already has a price or steps with skipExisting", async () => {
    const plan = await planCustomerPriceImport(
      {
        mapping: STAFFEL_MAPPING,
        rows: [
          ["6252", "A", "", "", "", "10", "90"],
          ["6252", "A", "", "", "", "20", "80"],
          ["6252", "B", "", "", "", "10", "90"],
        ],
        skipExisting: true,
      },
      fakeDeps(arts, ["6252"], [], [], [{ customerNumber: "6252", articleId: "id-a", fromQuantity: 50, id: "step-a50" }])
    );
    expect(plan.rows.map((row) => row.action)).toEqual(["skip", "skip", "create"]);
    expect(plan.rows[1]!.skipReason).toBe("Kunden 6252 har redan en koppling till artikel A");
    expect(plan.creates).toEqual([{ customerId: "cust-6252", articleId: "id-b", fromQuantity: 10, unitPrice: 90 }]);
    expect(plan.deletes).toEqual([]);
  });
});

describe("customer price import — staffel end to end", () => {
  it("commits the steps, replaces them on re-import and the price chain picks the step by quantity", async () => {
    const articleId = await seedArticle("ART-S");
    const customerId = await seedCustomer("6252");
    await db.update(articlesTable).set({ salesPrice: "999" }).where(eq(articlesTable.id, articleId));
    const stored = async () =>
      (
        await db
          .select({ fromQuantity: customerPrices.fromQuantity, unitPrice: customerPrices.unitPrice, setupPrice: customerPrices.setupPrice })
          .from(customerPrices)
          .where(eq(customerPrices.customerId, customerId))
      )
        .map((r) => ({ q: Number(r.fromQuantity), price: Number(r.unitPrice), setup: r.setupPrice === null ? null : Number(r.setupPrice) }))
        .sort((a, b) => a.q - b.q);

    const first = await importService.commit("customerPrices", {
      mapping: STAFFEL_MAPPING,
      rows: [
        ["6252", "ART-S", "120", "400", "", "20", "100"],
        ["6252", "ART-S", "120", "400", "", "50", "90"],
      ],
    });
    expect(first).toMatchObject({ created: 2, updated: 0 });
    expect(await stored()).toEqual([
      { q: 1, price: 120, setup: 400 },
      { q: 20, price: 100, setup: 400 },
      { q: 50, price: 90, setup: 400 },
    ]);
    const priceAt = async (quantity: number) =>
      (await resolvePrice(db, { customerId, articleId, quantity }))?.price?.unitPrice;
    expect([await priceAt(5), await priceAt(20), await priceAt(49), await priceAt(500)]).toEqual([120, 100, 100, 90]);

    // Step 20 changes, 50 is gone, 100 is new; Pris 0 removes the antal-1
    // rule, so below the first step the article's försäljningspris applies.
    await importService.commit("customerPrices", {
      mapping: STAFFEL_MAPPING,
      rows: [
        ["6252", "ART-S", "0", "", "", "20", "95"],
        ["6252", "ART-S", "0", "", "", "100", "85"],
      ],
    });
    expect(await stored()).toEqual([
      { q: 20, price: 95, setup: 400 },
      { q: 100, price: 85, setup: 400 },
    ]);
    expect([await priceAt(5), await priceAt(20), await priceAt(100)]).toEqual([999, 95, 85]);

    // The plain list (no step column) never touches the steps.
    await importService.commit("customerPrices", { mapping: MAPPING, rows: [["ART-S", "6252", "110", ""]] });
    expect((await stored()).map((r) => r.q)).toEqual([1, 20, 100]);
  });
});

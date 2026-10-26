import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { eq, sql } from "drizzle-orm";
import {
  articles,
  articleUnits,
  companyCarriers,
  customers,
  db,
  invoices,
  salesOrderRows,
  salesOrders,
  suppliers,
} from "@navet/db";
import { createRegisterRepository } from "../src/modules/register/repository/register.repository.js";
import {
  createRegisterService,
  InvalidReplacementError,
  RegisterEntryInUseError,
  RegisterEntryNotFoundError,
} from "../src/modules/register/service/register.service.js";

// Grunddata deletion with reassignment (NOTES.md #6): an unreferenced entry
// is simply deleted; a referenced one requires a replacement in the same
// register, and every referencing row (partners AND documents) is moved to
// it in one transaction before the delete.

const service = createRegisterService(createRegisterRepository(db));

const TRUNCATE = sql`TRUNCATE delivery_terms, payment_terms, carriers, units, package_types, article_codes, customers, suppliers, sales_orders, invoices, company_carriers, articles CASCADE`;

beforeEach(async () => {
  await db.execute(TRUNCATE);
});

afterAll(async () => {
  await db.execute(TRUNCATE);
});

async function makeCustomer(refs: Partial<typeof customers.$inferInsert> = {}) {
  const [row] = await db
    .insert(customers)
    .values({ customerNumber: `K-${crypto.randomUUID().slice(0, 8)}`, name: "Kund AB", ...refs })
    .returning();
  return row!;
}

async function makeSupplier(refs: Partial<typeof suppliers.$inferInsert> = {}) {
  const [row] = await db
    .insert(suppliers)
    .values({ supplierNumber: `L-${crypto.randomUUID().slice(0, 8)}`, name: "Leverantör AB", ...refs })
    .returning();
  return row!;
}

describe("register delete — unreferenced entry", () => {
  it("reports zero usage and deletes the entry outright", async () => {
    const term = await service.paymentTerms.create({ code: "30", name: "30 dagar" });
    expect(await service.paymentTerms.usage(term.id)).toEqual({ total: 0, references: [] });

    await service.paymentTerms.remove(term.id);
    expect(await service.paymentTerms.list()).toEqual([]);
  });

  it("throws RegisterEntryNotFoundError for an unknown id (usage and remove)", async () => {
    const ghost = crypto.randomUUID();
    await expect(service.carriers.usage(ghost)).rejects.toThrow(RegisterEntryNotFoundError);
    await expect(service.carriers.remove(ghost)).rejects.toThrow(RegisterEntryNotFoundError);
  });
});

describe("register delete — referenced entry needs a replacement", () => {
  it("usage lists the referencing kinds with Swedish labels and counts", async () => {
    const term = await service.paymentTerms.create({ code: "30", name: "30 dagar" });
    await makeCustomer({ paymentTermId: term.id });
    await makeCustomer({ paymentTermId: term.id });
    await makeSupplier({ paymentTermId: term.id });

    const usage = await service.paymentTerms.usage(term.id);
    expect(usage.total).toBe(3);
    expect(usage.references).toEqual([
      { table: "customers", label: "kunder", labelOne: "kund", count: 2 },
      { table: "suppliers", label: "leverantörer", labelOne: "leverantör", count: 1 },
    ]);
  });

  it("remove without a replacement throws RegisterEntryInUseError carrying the usage", async () => {
    const term = await service.deliveryTerms.create({ code: "EXW", name: "Från fabrik" });
    await makeCustomer({ deliveryTermId: term.id });

    const err = await service.deliveryTerms.remove(term.id).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(RegisterEntryInUseError);
    expect((err as RegisterEntryInUseError).usage.total).toBe(1);
    // Nothing changed.
    expect(await service.deliveryTerms.list()).toHaveLength(1);
  });

  it("with a replacement: partners and documents move, the original is gone, invoice snapshot text untouched", async () => {
    const old = await service.paymentTerms.create({ code: "30", name: "30 dagar" });
    const keep = await service.paymentTerms.create({ code: "30N", name: "30 dagar netto" });
    const customer = await makeCustomer({ paymentTermId: old.id });
    const supplier = await makeSupplier({ paymentTermId: old.id });
    const [order] = await db
      .insert(salesOrders)
      .values({ orderNumber: "KO-1", customerId: customer.id, paymentTermId: old.id })
      .returning();
    const [invoice] = await db
      .insert(invoices)
      .values({ customerId: customer.id, paymentTermId: old.id, paymentTermCode: "30", paymentTermName: "30 dagar" })
      .returning();

    const result = await service.paymentTerms.remove(old.id, keep.id);
    expect(result.moved).toEqual(
      expect.arrayContaining([
        { table: "customers", count: 1 },
        { table: "suppliers", count: 1 },
        { table: "sales_orders", count: 1 },
        { table: "invoices", count: 1 },
      ])
    );

    expect((await service.paymentTerms.list()).map((t) => t.code)).toEqual(["30N"]);
    const [c] = await db.select().from(customers).where(eq(customers.id, customer.id));
    const [s] = await db.select().from(suppliers).where(eq(suppliers.id, supplier.id));
    const [o] = await db.select().from(salesOrders).where(eq(salesOrders.id, order!.id));
    const [i] = await db.select().from(invoices).where(eq(invoices.id, invoice!.id));
    expect(c!.paymentTermId).toBe(keep.id);
    expect(s!.paymentTermId).toBe(keep.id);
    expect(o!.paymentTermId).toBe(keep.id);
    expect(i!.paymentTermId).toBe(keep.id);
    // The frozen print text on the issued invoice is history — never rewritten.
    expect(i!.paymentTermCode).toBe("30");
    expect(i!.paymentTermName).toBe("30 dagar");
  });

  it("rejects a replacement that is the entry itself, unknown, or from another register", async () => {
    const term = await service.paymentTerms.create({ code: "30", name: "30 dagar" });
    const foreign = await service.deliveryTerms.create({ code: "EXW", name: "Från fabrik" });
    await makeCustomer({ paymentTermId: term.id });

    await expect(service.paymentTerms.remove(term.id, term.id)).rejects.toThrow(InvalidReplacementError);
    await expect(service.paymentTerms.remove(term.id, crypto.randomUUID())).rejects.toThrow(InvalidReplacementError);
    await expect(service.paymentTerms.remove(term.id, foreign.id)).rejects.toThrow(InvalidReplacementError);
    expect(await service.paymentTerms.list()).toHaveLength(1);
  });
});

describe("register delete — merge semantics for unique link tables", () => {
  it("carriers: the company's own carrier account moves when the replacement has none", async () => {
    const old = await service.carriers.create({ code: "DHL", name: "DHL" });
    const keep = await service.carriers.create({ code: "DHLF", name: "DHL Freight" });
    await db.insert(companyCarriers).values({ carrierId: old.id, customerNumber: "ACC-1" });

    const usage = await service.carriers.usage(old.id);
    expect(usage.references).toEqual([{ table: "company_carriers", label: "företagets speditörskonton", labelOne: "företagets speditörskonto", count: 1 }]);

    await service.carriers.remove(old.id, keep.id);
    const rows = await db.select().from(companyCarriers);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.carrierId).toBe(keep.id);
    expect(rows[0]!.customerNumber).toBe("ACC-1");
  });

  it("carriers: when the replacement already has an account, the deleted carrier's row is dropped", async () => {
    const old = await service.carriers.create({ code: "DHL", name: "DHL" });
    const keep = await service.carriers.create({ code: "DHLF", name: "DHL Freight" });
    await db.insert(companyCarriers).values({ carrierId: old.id, customerNumber: "ACC-OLD" });
    await db.insert(companyCarriers).values({ carrierId: keep.id, customerNumber: "ACC-KEEP" });
    await makeCustomer({ carrierId: old.id });

    await service.carriers.remove(old.id, keep.id);
    const rows = await db.select().from(companyCarriers);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.carrierId).toBe(keep.id);
    expect(rows[0]!.customerNumber).toBe("ACC-KEEP");
    expect((await service.carriers.list()).map((c) => c.code)).toEqual(["DHLF"]);
  });

  it("units: articles, article units and order rows follow; factors untouched; duplicate article unit dropped", async () => {
    const st = await service.units.create({ code: "st", name: "Styck" });
    const ST = await service.units.create({ code: "ST", name: "STYCK" });
    const kg = await service.units.create({ code: "kg", name: "Kilogram" });
    const [article] = await db
      .insert(articles)
      .values({ articleNumber: "A-1", name: "Artikel", type: "purchased", unitId: ST.id, purchaseUnitId: ST.id })
      .returning();
    // A second article already has BOTH units as alternative units — moving
    // its ST row onto st would collide with unique(article_id, unit_id).
    const [article2] = await db
      .insert(articles)
      .values({ articleNumber: "A-2", name: "Artikel 2", type: "purchased", unitId: kg.id })
      .returning();
    await db.insert(articleUnits).values({ articleId: article2!.id, unitId: st.id, quantityPerBase: "1" });
    await db.insert(articleUnits).values({ articleId: article2!.id, unitId: ST.id, quantityPerBase: "1" });
    const customer = await makeCustomer();
    const [order] = await db.insert(salesOrders).values({ orderNumber: "KO-2", customerId: customer.id }).returning();
    const [row] = await db
      .insert(salesOrderRows)
      .values({
        salesOrderId: order!.id,
        articleId: article!.id,
        quantityOrdered: "10",
        unitPrice: "5",
        unitId: ST.id,
        unitFactor: "12",
      })
      .returning();

    const usage = await service.units.usage(ST.id);
    expect(usage.total).toBe(4); // articles.unit_id + articles.purchase_unit_id + article_units + sales_order_rows

    await service.units.remove(ST.id, st.id);

    const [a] = await db.select().from(articles).where(eq(articles.id, article!.id));
    expect(a!.unitId).toBe(st.id);
    expect(a!.purchaseUnitId).toBe(st.id);
    const alt = await db.select().from(articleUnits).where(eq(articleUnits.articleId, article2!.id));
    expect(alt).toHaveLength(1);
    expect(alt[0]!.unitId).toBe(st.id);
    const [r] = await db.select().from(salesOrderRows).where(eq(salesOrderRows.id, row!.id));
    expect(r!.unitId).toBe(st.id);
    expect(r!.unitFactor).toBe("12.000000");
    expect((await service.units.list()).map((u) => u.code)).toEqual(["kg", "st"]);
  });
});

describe("register delete — artikelkoder", () => {
  it("lists the articles carrying the code and moves them to the replacement", async () => {
    const st = await service.units.create({ code: "st-ak", name: "Styck AK" });
    const old = await service.articleCodes.create({ code: "100", name: "Plåt" });
    const replacement = await service.articleCodes.create({ code: "120", name: "Plåt, rostfri" });
    const [article] = await db
      .insert(articles)
      .values({ articleNumber: "AK-1", name: "Kodad", type: "purchased", unitId: st.id, articleCodeId: old.id })
      .returning();

    expect(await service.articleCodes.usage(old.id)).toEqual({
      total: 1,
      references: [{ table: "articles", label: "artiklar", labelOne: "artikel", count: 1 }],
    });
    await expect(service.articleCodes.remove(old.id)).rejects.toThrow(RegisterEntryInUseError);

    await service.articleCodes.remove(old.id, replacement.id);
    const [moved] = await db.select({ articleCodeId: articles.articleCodeId }).from(articles).where(eq(articles.id, article!.id));
    expect(moved!.articleCodeId).toBe(replacement.id);
    expect((await service.articleCodes.list()).map((c) => c.code)).toEqual(["120"]);
  });
});

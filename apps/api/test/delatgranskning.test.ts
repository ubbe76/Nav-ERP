import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { eq, sql } from "drizzle-orm";
import { assertAscendingJournal, db, fiscalYears, stockLocations, stockTransactions, warehouses } from "@navet/db";
import {
  computedVatAmount,
  createContactSchema,
  createCustomerSchema,
  createSalesOrderRowSchema,
  createSupplierSchema,
  customerPriceInputSchema,
  invoiceRowInputSchema,
  round2,
  round4,
  roundToDecimals,
  updateSupplierInvoiceRowSchema,
  vatRateSchema,
} from "@navet/shared";
import { createAuthRepository } from "../src/modules/auth/repository/auth.repository.js";
import { createEconomyRepository } from "../src/modules/economy/repository/economy.repository.js";
import { createEconomyService, OverlappingFiscalYearError } from "../src/modules/economy/service/economy.service.js";
import { getOrCreateFallbackLocation } from "../src/modules/stock/service/location-resolver.js";
import { createStockRepository } from "../src/modules/stock/repository/stock.repository.js";
import { createStockService } from "../src/modules/stock/service/stock.service.js";
import { createArticleRepository } from "../src/modules/article/repository/article.repository.js";
import { createArticleService } from "../src/modules/article/service/article.service.js";
import { createArticleSchema } from "@navet/shared";
import { parsed } from "./helpers/parsed.js";
// The web copies load directly (no imports), like the other web mirrors.
import * as webFormat from "../../web/lib/format.js";
import * as webPaymentTolerance from "../../web/lib/paymentTolerance.js";
import * as webVatCodes from "../../web/lib/vatCodes.js";

// Delatgranskningen 2026-11-11: packages/shared and packages/db reviewed as
// units of their own. Rounding, null-as-zero, the stock log's append-only
// guard, the fallback place, overlapping räkenskapsår and the journal check.

const REPO_ROOT = fileURLToPath(new URL("../../../", import.meta.url));

describe("öre rounding — one rule everywhere", () => {
  it("the web copies round like @navet/shared", () => {
    for (const n of [1.005, 2.175, 10.075, 8597.755, -2.175, -0.004, 0, 1234.5649, 99.995]) {
      expect(webFormat.round2(n)).toBe(round2(n));
      expect(webPaymentTolerance.round2(n)).toBe(round2(n));
    }
  });

  it("the web's round4 and roundToDecimals round like @navet/shared", () => {
    for (const n of [1.00005, 0.1 + 0.2, 8597.755, 2.175, -1.00005, -2.5, -0.00004, 0, 1234.56785, 4123456.4999999995, 0.5, 1.005]) {
      expect(webFormat.round4(n)).toBe(round4(n));
      for (const d of [0, 1, 2, 3, 4, 6]) expect(webFormat.roundToDecimals(n, d)).toBe(roundToDecimals(n, d));
    }
  });

  it("computed (omvänd) VAT rounds a half öre up above 1 MSEK", () => {
    expect(computedVatAmount(1_049_385.9, 25)).toBe(262_346.48);
    expect(computedVatAmount(-1_049_385.9, 25)).toBe(-262_346.48);
    expect(Object.is(computedVatAmount(-0.01, 25), 0)).toBe(true);
    for (const [base, rate] of [
      [1_049_385.9, 25],
      [8.54, 25],
      [100.1, 12],
      [-77.77, 6],
    ] as const) {
      expect(webVatCodes.computedVatAmount(base, rate)).toBe(computedVatAmount(base, rate));
    }
  });

  // The `+ Number.EPSILON` nudge only helped below ~2 kr; every copy now
  // goes through roundToDecimals (or the web's identical copy). A new copy
  // of the old pattern fails here.
  it("no code rounds with the old epsilon nudge", () => {
    const roots = ["apps/api/src", "apps/web/lib", "apps/web/components", "apps/web/app", "packages/shared/src"];
    const offenders: string[] = [];
    const walk = (dir: string) => {
      for (const name of readdirSync(dir)) {
        const path = join(dir, name);
        if (statSync(path).isDirectory()) walk(path);
        else if (/\.tsx?$/.test(name)) {
          readFileSync(path, "utf8")
            .split("\n")
            .forEach((line, i) => {
              if (/^\s*\/\//.test(line)) return;
              if (/\+\s*Number\.EPSILON\)\s*\*/.test(line) || /\*\s*rate\s*\+\s*1e-9\)/.test(line)) offenders.push(`${path}:${i + 1}`);
            });
        }
      }
    };
    for (const root of roots) walk(join(REPO_ROOT, root));
    expect(offenders).toEqual([]);
  });

  // A plain `Math.round(x * 100) / 100` rounds 1.005 to 1.00 and 8597.755 to
  // 8597.75, and negative halves toward +infinity. The one rule is
  // roundToDecimals (money.ts, copied into the web's format.ts). Same-factor
  // scale-round-unscale on one line is refused in every source root.
  it("no code rounds with a plain Math.round(x * factor) / factor", () => {
    const roots = ["apps/api/src", "apps/web/lib", "apps/web/components", "apps/web/app", "packages/shared/src"];
    // pain001-check compares an amount with its own two-decimal rounding to
    // validate it, on purpose.
    const allowed = ["apps/api/src/modules/banking/service/iso20022/pain001-check.ts"];
    const pattern = /Math\.round\([^;]*\*\s*(1e\d+|\d[\d_]*)\s*\)\s*\/\s*\1(?![\w.])/;
    const offenders: string[] = [];
    const walk = (dir: string) => {
      for (const name of readdirSync(dir)) {
        const path = join(dir, name);
        if (statSync(path).isDirectory()) walk(path);
        else if (/\.tsx?$/.test(name) && !allowed.some((a) => path.endsWith(a))) {
          readFileSync(path, "utf8")
            .split("\n")
            .forEach((line, i) => {
              if (/^\s*(\/\/|\*|\/\*)/.test(line)) return;
              if (pattern.test(line)) offenders.push(`${path}:${i + 1}`);
            });
        }
      }
    };
    for (const root of roots) walk(join(REPO_ROOT, root));
    expect(offenders).toEqual([]);
  });
});

describe("null is not 0 in number fields", () => {
  const articleId = "00000000-0000-4000-8000-000000000001";

  it("an order row's unitPrice: null is refused, not a 0 kr manual price", () => {
    expect(createSalesOrderRowSchema.safeParse({ articleId, quantity: 1, unitPrice: null }).success).toBe(false);
    expect(createSalesOrderRowSchema.safeParse({ articleId, quantity: 1, discountPercent: null }).success).toBe(false);
    // Omitted still means "look the price up"; 0 still means free.
    expect(createSalesOrderRowSchema.parse({ articleId, quantity: 1 }).unitPrice).toBeUndefined();
    expect(createSalesOrderRowSchema.parse({ articleId, quantity: 1, unitPrice: 0 }).unitPrice).toBe(0);
  });

  it("an invoice row's vatRate: null or '' is not 0 % (momskod MF)", () => {
    expect(vatRateSchema.safeParse(null).success).toBe(false);
    expect(vatRateSchema.safeParse("").success).toBe(false);
    expect(vatRateSchema.parse("12")).toBe(12);
    expect(vatRateSchema.parse(0)).toBe(0);
    const row = { description: "Fri rad", quantity: 1, unitPrice: 100 };
    expect(invoiceRowInputSchema.safeParse({ ...row, vatRate: null }).success).toBe(false);
    expect(invoiceRowInputSchema.safeParse({ ...row, unitPrice: null }).success).toBe(false);
    expect(invoiceRowInputSchema.parse(row).vatRate).toBeUndefined();
  });

  it("where null means something (.nullable() outside) it still passes", () => {
    expect(updateSupplierInvoiceRowSchema.parse({ vatRate: null }).vatRate).toBeNull();
    const price = customerPriceInputSchema.parse({ articleId, unitPrice: null, discountPercent: 10 });
    expect(price.unitPrice).toBeNull();
    expect(price.discountPercent).toBe(10);
  });
});

describe("e-mail fields fit varchar(255)", () => {
  const long = `${"a".repeat(64)}@${"b".repeat(63)}.${"c".repeat(63)}.${"d".repeat(63)}.se`; // 259 characters, a valid address
  it("is a 400, not a 22001 → 500", () => {
    expect(long.length).toBeGreaterThan(255);
    expect(createCustomerSchema.safeParse({ name: "Kund", email: long }).success).toBe(false);
    expect(createSupplierSchema.safeParse({ name: "Leverantör", email: long }).success).toBe(false);
    expect(createContactSchema.safeParse({ name: "Kontakt", email: long }).success).toBe(false);
  });
});

describe("the migration journal", () => {
  it("is strictly ascending, and the runner refuses one that is not", () => {
    const journal = JSON.parse(readFileSync(join(REPO_ROOT, "packages/db/drizzle/meta/_journal.json"), "utf8")) as {
      entries: { when: number }[];
    };
    expect(() => assertAscendingJournal(journal.entries.map((e) => e.when))).not.toThrow();
    expect(() => assertAscendingJournal([1, 3, 2])).toThrow(/not strictly ascending/);
    expect(() => assertAscendingJournal([1, 2, 2])).toThrow(/not strictly ascending/);
  });
});

describe("database guards (migration 0208)", () => {
  const TABLES = sql`TRUNCATE stock_transactions, stock_locations, warehouses, articles, accounting_periods, fiscal_years, users CASCADE`;
  const stockService = createStockService(createStockRepository(db));
  const articleService = createArticleService(createArticleRepository(db));
  const authRepo = createAuthRepository(db);

  beforeEach(async () => {
    await db.execute(TABLES);
  });
  afterAll(async () => {
    await db.execute(TABLES);
  });

  async function stockRow(createdBy: string | null = null) {
    const article = await articleService.createArticle(
      parsed(createArticleSchema, { articleNumber: `ART-${crypto.randomUUID()}`, name: "Skruv", type: "purchased", active: true })
    );
    const locationId = await getOrCreateFallbackLocation(db);
    const [row] = await db
      .insert(stockTransactions)
      .values({ articleId: article.id, locationId, quantityDelta: "5", transactionType: "inventory_adjustment", unitCost: "10", createdBy })
      .returning();
    return row!;
  }

  function sqlState(err: unknown): string | undefined {
    const e = err as { code?: string; cause?: { code?: string } };
    return e?.code ?? e?.cause?.code;
  }

  it("the stock log refuses UPDATE and DELETE (NV001)", async () => {
    const row = await stockRow();
    const update = await db.update(stockTransactions).set({ unitCost: "99" }).where(eq(stockTransactions.id, row.id)).then(() => null, (err) => err);
    expect(sqlState(update)).toBe("NV001");
    const remove = await db.delete(stockTransactions).where(eq(stockTransactions.id, row.id)).then(() => null, (err) => err);
    expect(sqlState(remove)).toBe("NV001");
    const [still] = await db.select().from(stockTransactions).where(eq(stockTransactions.id, row.id));
    expect(still!.unitCost).toBe("10.0000");
  });

  it("a deleted user's created_by is still set to null", async () => {
    const user = await authRepo.create({ email: `st-${crypto.randomUUID()}@example.com`, passwordHash: "x", name: "Lager", role: "admin" });
    const row = await stockRow(user.id);
    await db.execute(sql`DELETE FROM users WHERE id = ${user.id}`);
    const [after] = await db.select().from(stockTransactions).where(eq(stockTransactions.id, row.id));
    expect(after!.createdBy).toBeNull();
  });

  it("two first-ever writers get the same `***`", async () => {
    const ids = await Promise.all(Array.from({ length: 6 }, () => getOrCreateFallbackLocation(db)));
    expect(new Set(ids).size).toBe(1);
    expect(await db.select().from(stockLocations).where(eq(stockLocations.name, "***"))).toHaveLength(1);
    expect(await db.select().from(warehouses).where(eq(warehouses.name, "***"))).toHaveLength(1);
  });

  it("räkenskapsår may not overlap even when the service's check is passed", async () => {
    const realRepo = createEconomyRepository(db);
    // A second create that read the years before the first committed.
    const staleRepo = { ...realRepo, listFiscalYears: async () => [] };
    const service = createEconomyService(staleRepo, { log: async () => {} });
    await service.createFiscalYear({ label: "2026", startDate: "2026-01-01", endDate: "2026-12-31" });
    await expect(service.createFiscalYear({ label: "2026/27", startDate: "2026-07-01", endDate: "2027-06-30" })).rejects.toBeInstanceOf(
      OverlappingFiscalYearError
    );
    // Edge to edge is fine.
    await service.createFiscalYear({ label: "2027", startDate: "2027-01-01", endDate: "2027-12-31" });
    expect(await db.select().from(fiscalYears)).toHaveLength(2);
  });
});

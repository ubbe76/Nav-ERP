import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { asc, eq, getTableColumns, sql } from "drizzle-orm";
import { accounts, articleGroups, db, fiscalYears, verificationRows, verifications, verificationSeries } from "@navet/db";
import { VAT_CODES, round2, type VatCode } from "@navet/shared";
import { createAuthRepository } from "../src/modules/auth/repository/auth.repository.js";
import { createEconomyRepository } from "../src/modules/economy/repository/economy.repository.js";
import { createEconomyService } from "../src/modules/economy/service/economy.service.js";
import { BAS_STANDARD_ACCOUNTS } from "../src/modules/economy/service/bas-accounts.js";
import {
  SupplierInvoiceVatCodeError,
  VatCodeAccountConflictError,
  VatCodeAmountMismatchError,
  VatCodeNotApplicableError,
  createVerificationPoster,
  type PostingVatCode,
} from "../src/modules/economy/service/verification-poster.js";
import { readVatAccountMovements } from "../src/modules/economy/service/vat-account-movements.js";
import { bucketMovements } from "../src/modules/economy/service/vat-report.service.js";
import { postingVatCode } from "./helpers/vat-codes.js";

// Momskoder in the automatkontering: which account each code posts to, the
// "Alla momskoder" rule only for domestic codes, omvänd moms computed on a
// supplier invoice, and the importmoms posting — each checked down to the
// declaration boxes the accounts carry.

const repo = createEconomyRepository(db);
const authRepo = createAuthRepository(db);
const service = createEconomyService(repo, { log: async () => {} });

const TRUNCATE = sql`TRUNCATE verification_rows, verifications, verification_counters, verification_series, accounting_periods, fiscal_years, accounts, posting_rules, article_groups, audit_log, users CASCADE`;

const SETTINGS = {
  postingAccountsReceivable: "1510",
  postingAccountsPayable: "2440",
  postingDefaultCost: "4010",
  postingBank: "1930",
  postingReminderFeeAccount: "3540",
  postingPaymentWriteOff: "3740",
  postingVatSettlement: "2650",
  postingInventory: "1460",
  postingInventoryChange: "4990",
};
const poster = createVerificationPoster({ read: async () => SETTINGS });

const C = {} as Record<VatCode, PostingVatCode>;
beforeAll(async () => {
  for (const code of VAT_CODES) C[code] = await postingVatCode(code);
});
beforeEach(async () => {
  await db.execute(TRUNCATE);
});
afterAll(async () => {
  await db.execute(TRUNCATE);
});

const YEAR = new Date().getFullYear();
const DATE = `${YEAR}-03-15`;

async function setup() {
  const user = await authRepo.create({
    email: `vat-codes-posting-${crypto.randomUUID()}@example.com`,
    passwordHash: "not-a-real-hash",
    name: "Ekonomiadmin",
    role: "admin",
  });
  await service.createFiscalYear({ label: String(YEAR), startDate: `${YEAR}-01-01`, endDate: `${YEAR}-12-31` });
  await repo.seedAccounts(BAS_STANDARD_ACCOUNTS);
  return { user };
}

async function rowsOf(verificationId: string) {
  const rows = await db
    .select({ account: accounts.number, debit: verificationRows.debit, credit: verificationRows.credit })
    .from(verificationRows)
    .innerJoin(accounts, eq(accounts.id, verificationRows.accountId))
    .where(eq(verificationRows.verificationId, verificationId))
    .orderBy(asc(verificationRows.createdAt));
  const byAccount = Object.fromEntries(rows.map((row) => [row.account, round2(Number(row.debit) - Number(row.credit))]));
  const debit = round2(rows.reduce((sum, row) => sum + Number(row.debit), 0));
  const credit = round2(rows.reduce((sum, row) => sum + Number(row.credit), 0));
  expect(debit).toBe(credit);
  return byAccount;
}

async function boxes() {
  return bucketMovements(await readVatAccountMovements(db, `${YEAR}-01-01`, `${YEAR}-12-31`));
}

async function group(code: string) {
  const [row] = await db.insert(articleGroups).values({ code, name: `Grupp ${code}` }).returning();
  return row!;
}

const CUSTOMER_DOC = { invoiceNumber: "FA-1", type: "invoice" as const, invoiceDate: DATE, customerName: "Kund GmbH" };
const supplierDoc = (vatCode: PostingVatCode, net: number, vat: number) => ({
  registrationNumber: "LF-1",
  invoiceNumber: "INV-1",
  supplierName: "Lieferant GmbH",
  invoiceDate: DATE,
  currency: "SEK",
  netAmount: net,
  vatAmount: vat,
  grossAmount: round2(net + vat),
  vatCode,
});

describe("momskoder — customer invoice", () => {
  it("posts an EU goods sale to 3108 (ruta 35) with no VAT and an OB row to 3231 (ruta 41)", async () => {
    const { user } = await setup();
    const posted = await db.transaction((tx) =>
      poster.postCustomerInvoice(
        tx,
        CUSTOMER_DOC,
        [
          { articleGroupId: null, lineAmount: 1000, vatAmount: 0, vatRate: 0, vatCode: C.EUV },
          { articleGroupId: null, lineAmount: 300, vatAmount: 0, vatRate: 0, vatCode: C.OB },
          { articleGroupId: null, lineAmount: 200, vatAmount: 0, vatRate: 0, vatCode: C.EXT },
        ],
        user.id
      )
    );
    expect(await rowsOf(posted.verificationId)).toEqual({ "1510": 1500, "3108": -1000, "3231": -300, "3305": -200 });
    const result = await boxes();
    expect(result["35"]).toBe(1000);
    expect(result["41"]).toBe(300);
    expect(result["40"]).toBe(200);
    expect(result["05"]).toBe(0);
    expect(result["49"]).toBe(0);
  });

  it("lets a catch-all rule take the domestic code but never the EU sale; an exact EUV rule does", async () => {
    const { user } = await setup();
    const g = await group("310");
    const domestic = await service.createAccount({ number: "3010", name: "Försäljning diskbänkar", vatBox: "05" });
    await service.createPostingRule({ articleGroupId: g.id, vatCodeId: null, revenueAccountId: domestic.id, costAccountId: null });

    const first = await db.transaction((tx) =>
      poster.postCustomerInvoice(
        tx,
        CUSTOMER_DOC,
        [
          { articleGroupId: g.id, lineAmount: 1000, vatAmount: 250, vatRate: 25, vatCode: C.MP25 },
          { articleGroupId: g.id, lineAmount: 400, vatAmount: 0, vatRate: 0, vatCode: C.EUV },
        ],
        user.id
      )
    );
    expect(await rowsOf(first.verificationId)).toEqual({ "1510": 1650, "3010": -1000, "2610": -250, "3108": -400 });

    const eu = await service.createAccount({ number: "3109", name: "Försäljning diskbänkar EU", vatBox: "35" });
    await service.createPostingRule({ articleGroupId: g.id, vatCodeId: C.EUV.id, revenueAccountId: eu.id, costAccountId: null });
    const second = await db.transaction((tx) =>
      poster.postCustomerInvoice(
        tx,
        { ...CUSTOMER_DOC, invoiceNumber: "FA-2" },
        [{ articleGroupId: g.id, lineAmount: 400, vatAmount: 0, vatRate: 0, vatCode: C.EUV }],
        user.id
      )
    );
    expect(await rowsOf(second.verificationId)).toEqual({ "1510": 400, "3109": -400 });
  });

  it("refuses VAT on a 0 % code, a rate that is not the code's, and a purchase code", async () => {
    const { user } = await setup();
    const post = (row: { lineAmount: number; vatAmount: number; vatRate: number; vatCode: PostingVatCode }) =>
      db.transaction((tx) => poster.postCustomerInvoice(tx, CUSTOMER_DOC, [{ articleGroupId: null, ...row }], user.id));

    await expect(post({ lineAmount: 1000, vatAmount: 250, vatRate: 0, vatCode: C.EUV })).rejects.toBeInstanceOf(
      VatCodeAmountMismatchError
    );
    await expect(post({ lineAmount: 1000, vatAmount: 250, vatRate: 25, vatCode: C.MP12 })).rejects.toBeInstanceOf(
      VatCodeAmountMismatchError
    );
    await expect(post({ lineAmount: 1000, vatAmount: 250, vatRate: 25, vatCode: C.IEUV25 })).rejects.toBeInstanceOf(
      VatCodeNotApplicableError
    );
    expect(await db.select().from(verifications)).toHaveLength(0);
  });
});

describe("momskoder — supplier invoice", () => {
  it("books omvänd moms on an EU goods purchase: 4515 (ruta 20), 2614 (ruta 30) and 2645 (ruta 48)", async () => {
    const { user } = await setup();
    const posted = await db.transaction((tx) => poster.postSupplierInvoice(tx, supplierDoc(C.IEUV25, 1000, 0), [], user.id));
    expect(await rowsOf(posted.verificationId)).toEqual({ "2440": -1000, "4515": 1000, "2614": -250, "2645": 250 });
    const result = await boxes();
    expect(result["20"]).toBe(1000);
    expect(result["30"]).toBe(250);
    expect(result["48"]).toBe(250);
    expect(result["49"]).toBe(0);
  });

  it("splits a mixed invoice per code: charged VAT on the header code, omvänd moms on the row's", async () => {
    const { user } = await setup();
    const posted = await db.transaction((tx) =>
      poster.postSupplierInvoice(
        tx,
        supplierDoc(C.MP25, 2000, 250),
        [
          { articleGroupId: null, lineAmount: 1000, vatCode: null },
          { articleGroupId: null, lineAmount: 600, vatCode: C.IEUT },
          { articleGroupId: null, lineAmount: 200, vatCode: C.IUTT },
        ],
        user.id
      )
    );
    // 2000 − 1800 = 200 kr remainder under the header's MP25 → default cost.
    expect(await rowsOf(posted.verificationId)).toEqual({
      "2440": -2250,
      "2640": 250,
      "4010": 1200,
      "4535": 600,
      "4531": 200,
      "2614": -200,
      "2645": 200,
    });
    const result = await boxes();
    expect(result["21"]).toBe(600);
    expect(result["22"]).toBe(200);
    expect(result["30"]).toBe(200);
    expect(result["48"]).toBe(450);
  });

  it("puts the remainder of an omvänd-moms header on the code's cost account and computes VAT on it", async () => {
    const { user } = await setup();
    const posted = await db.transaction((tx) =>
      poster.postSupplierInvoice(tx, supplierDoc(C.IOBT, 1000.02, 0), [{ articleGroupId: null, lineAmount: 600, vatCode: null }], user.id)
    );
    // VAT on 1000.02 at 25 % = 250.005 → 250.01 (half away from zero).
    expect(await rowsOf(posted.verificationId)).toEqual({ "2440": -1000.02, "4425": 1000.02, "2614": -250.01, "2647": 250.01 });
  });

  it("mirrors the computed VAT on a supplier credit note", async () => {
    const { user } = await setup();
    const posted = await db.transaction((tx) => poster.postSupplierInvoice(tx, supplierDoc(C.IEUV12, -1000.02, 0), [], user.id));
    // −1000.02 × 12 % = −120.0024 → −120.00
    expect(await rowsOf(posted.verificationId)).toEqual({ "2440": 1000.02, "4516": -1000.02, "2624": 120, "2645": -120 });
  });

  it("uses an exact cost rule for an omvänd code but never the catch-all; IUTV takes the catch-all", async () => {
    const { user } = await setup();
    const g = await group("410");
    const material = await service.createAccount({ number: "4011", name: "Inköp material grupp", vatBox: null });
    await service.createPostingRule({ articleGroupId: g.id, vatCodeId: null, revenueAccountId: null, costAccountId: material.id });

    const reverse = await db.transaction((tx) =>
      poster.postSupplierInvoice(tx, supplierDoc(C.IEUV25, 1000, 0), [{ articleGroupId: g.id, lineAmount: 1000, vatCode: null }], user.id)
    );
    expect((await rowsOf(reverse.verificationId))["4515"]).toBe(1000);

    const outside = await db.transaction((tx) =>
      poster.postSupplierInvoice(
        tx,
        { ...supplierDoc(C.IUTV, 500, 0), registrationNumber: "LF-2" },
        [{ articleGroupId: g.id, lineAmount: 500, vatCode: null }],
        user.id
      )
    );
    expect(await rowsOf(outside.verificationId)).toEqual({ "2440": -500, "4011": 500 });

    const euCost = await service.createAccount({ number: "4519", name: "Inköp EU grupp", vatBox: "20" });
    await service.createPostingRule({ articleGroupId: g.id, vatCodeId: C.IEUV25.id, revenueAccountId: null, costAccountId: euCost.id });
    const exact = await db.transaction((tx) =>
      poster.postSupplierInvoice(
        tx,
        { ...supplierDoc(C.IEUV25, 1000, 0), registrationNumber: "LF-3" },
        [{ articleGroupId: g.id, lineAmount: 1000, vatCode: null }],
        user.id
      )
    );
    expect(await rowsOf(exact.verificationId)).toEqual({ "2440": -1000, "4519": 1000, "2614": -250, "2645": 250 });
  });

  it("refuses charged VAT on a header code that cannot carry it (SupplierInvoiceVatCodeError)", async () => {
    const { user } = await setup();
    for (const code of [C.IEUV25, C.MF, C.IUTV]) {
      await expect(
        db.transaction((tx) => poster.postSupplierInvoice(tx, supplierDoc(code, 1000, 250), [], user.id))
      ).rejects.toBeInstanceOf(SupplierInvoiceVatCodeError);
    }
    await expect(
      db.transaction((tx) =>
        poster.postSupplierInvoice(tx, supplierDoc(C.MP25, 1000, 0), [{ articleGroupId: null, lineAmount: 1000, vatCode: C.EUV }], user.id)
      )
    ).rejects.toBeInstanceOf(VatCodeNotApplicableError);
    expect(await db.select().from(verifications)).toHaveLength(0);
  });

  it("refuses an omvänd code whose utgående and ingående moms share an account", async () => {
    const { user } = await setup();
    await expect(
      db.transaction((tx) =>
        poster.postSupplierInvoice(tx, supplierDoc({ ...C.IEUV25, inputVatAccount: "2614" }, 1000, 0), [], user.id)
      )
    ).rejects.toBeInstanceOf(VatCodeAccountConflictError);
  });
});

describe("momskoder — importmoms", () => {
  it("books the tax base on 4545/4546 against 4549 and the VAT in ruta 60/61 and 48 in series IM", async () => {
    const { user } = await setup();
    const posted = await db.transaction((tx) =>
      poster.postImportVat(
        tx,
        {
          date: DATE,
          description: "Importmoms tullbeslut 123",
          rows: [
            { vatCode: C.IMP25, taxBase: 10000 },
            { vatCode: C.IMP12, taxBase: 1000 },
          ],
        },
        user.id
      )
    );
    expect(posted.displayNumber).toBe(`IM-${YEAR}-1`);
    const [header] = await db
      .select({ ...getTableColumns(verifications), seriesCode: verificationSeries.code, seriesName: verificationSeries.name })
      .from(verifications)
      .innerJoin(verificationSeries, eq(verificationSeries.id, verifications.seriesId))
      .innerJoin(fiscalYears, eq(fiscalYears.id, verifications.fiscalYearId))
      .where(eq(verifications.id, posted.verificationId));
    expect(header!.seriesName).toBe("Importmoms");
    expect(header!.description).toBe("Importmoms tullbeslut 123");
    expect(await rowsOf(posted.verificationId)).toEqual({
      "4545": 10000,
      "4546": 1000,
      "4549": -11000,
      "2645": 2620,
      "2615": -2500,
      "2625": -120,
    });
    const result = await boxes();
    expect(result["50"]).toBe(11000);
    expect(result["60"]).toBe(2500);
    expect(result["61"]).toBe(120);
    expect(result["48"]).toBe(2620);
    expect(result["49"]).toBe(0);
  });

  it("refuses a code that is not an import code and a base posted against itself", async () => {
    const { user } = await setup();
    await expect(
      db.transaction((tx) =>
        poster.postImportVat(tx, { date: DATE, description: "x", rows: [{ vatCode: C.MP25, taxBase: 100 }] }, user.id)
      )
    ).rejects.toBeInstanceOf(VatCodeNotApplicableError);
    await expect(
      db.transaction((tx) =>
        poster.postImportVat(
          tx,
          { date: DATE, description: "x", rows: [{ vatCode: { ...C.IMP25, baseCounterAccount: "4545" }, taxBase: 100 }] },
          user.id
        )
      )
    ).rejects.toBeInstanceOf(VatCodeAccountConflictError);
  });
});

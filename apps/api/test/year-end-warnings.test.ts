import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { db, supplierInvoices, suppliers, vatSettlements } from "@navet/db";
import { formatNumber } from "../src/modules/mail/service/document-pdf.js";
import { testEconomyService } from "./helpers/services.js";
import { testFixedAssetService } from "./helpers/fixed-assets.js";
import {
  PREVIOUS_YEAR,
  YEAR,
  accountId,
  bookManual,
  buildYearEndService,
  createCalendarYear,
  resetYearEnd,
  setupYearEnd,
  testYearEndPoster,
} from "./helpers/year-end.js";
import { vatCodeId } from "./helpers/vat-codes.js";

beforeEach(resetYearEnd);
afterAll(resetYearEnd);

const service = buildYearEndService();

async function settle(fromDate: string, toDate: string, userId: string) {
  const booked = await bookManual(toDate, [{ account: "2610", debit: 1 }, { account: "2650", credit: 1 }], userId);
  await db.insert(vatSettlements).values({ fromDate, toDate, verificationId: booked.id, createdBy: userId });
}

async function settleThrough(lastMonth: number, userId: string) {
  for (let month = 1; month <= lastMonth; month++) {
    const key = `${YEAR}-${String(month).padStart(2, "0")}`;
    const end = new Date(Date.UTC(YEAR, month, 0)).toISOString().slice(0, 10);
    await settle(`${key}-01`, end, userId);
  }
}

describe("steg 1 — step blockers", () => {
  it("blocks on drafts, an open previous year and a locked closing month", async () => {
    const { user, yearId } = await setupYearEnd();
    await createCalendarYear(PREVIOUS_YEAR);
    const series = await testEconomyService.createSeries({ code: "A", name: "Manuella" });
    await testEconomyService.createVerification({ seriesId: series.id, date: `${YEAR}-03-01`, description: "Utkast", rows: [] }, user.id);
    const closing = await service.startClosing({ fiscalYearId: yearId }, user.id);
    await testEconomyService.lockPeriod(closing.closingPeriod.id, user.id);

    const detail = await service.getClosing(closing.id);
    expect(detail.checks.stepBlockers.map((check) => check.code)).toEqual([
      "draft-verifications",
      "previous-year-open",
      "closing-period-locked",
    ]);
    // The blocker links the drafts (spec 4.2), at most 20.
    expect(detail.checks.draftVerifications).toEqual([
      expect.objectContaining({ id: expect.any(String), date: `${YEAR}-03-01`, description: "Utkast" }),
    ]);
  });
});

describe("steg 1 — warnings", () => {
  it("warns about every unsettled VAT month, then only about December", async () => {
    const { user, yearId } = await setupYearEnd();
    const closing = await service.startClosing({ fiscalYearId: yearId }, user.id);
    const before = (await service.getClosing(closing.id)).checks.warnings.find((w) => w.code === "vat-unsettled");
    expect(before!.message).toContain("januari 2024");
    expect(before!.message).toContain("december 2024");

    await settleThrough(11, user.id);
    const after = (await service.getClosing(closing.id)).checks.warnings.find((w) => w.code === "vat-unsettled");
    expect(after!.message).toBe("Momsen är inte omförd för: december 2024 — efter stängningen kan den inte bokföras i året");
  });

  it("warns when the receivable account carries a booking the reskontra does not know", async () => {
    const { user, yearId } = await setupYearEnd();
    await settleThrough(12, user.id);
    await bookManual(`${YEAR}-12-15`, [{ account: "1510", credit: 60 }, { account: "3740", debit: 60 }], user.id);
    const closing = await service.startClosing({ fiscalYearId: yearId }, user.id);
    const warning = (await service.getClosing(closing.id)).checks.warnings.find((w) => w.code === "receivables-mismatch");
    expect(warning!.message).toBe(
      `Kundreskontran stämmer inte mot konto 1510: huvudbok ${formatNumber(-60)}, reskontra ${formatNumber(0)} (skillnad ${formatNumber(-60)})`
    );
  });

  it("warns about a fixed-asset register that does not match the asset account", async () => {
    const { user, yearId } = await setupYearEnd();
    const category = await testFixedAssetService.createCategory({
      name: "Inventarier",
      assetAccountId: await accountId("1220"),
      accumulatedDepreciationAccountId: await accountId("1229"),
      depreciationExpenseAccountId: await accountId("7830"),
      disposalGainAccountId: await accountId("3973"),
      disposalLossAccountId: await accountId("7970"),
      defaultUsefulLifeMonths: 60,
    });
    await testFixedAssetService.createAsset(
      { name: "Svarv", categoryId: category.id, acquisitionDate: `${YEAR}-03-10`, acquisitionCost: 50000 },
      user.id
    );
    const closing = await service.startClosing({ fiscalYearId: yearId }, user.id);
    const warning = (await service.getClosing(closing.id)).checks.warnings.find((w) => w.code === "fixed-assets-mismatch");
    expect(warning!.message).toMatch(/^Anläggningsregistret: 1220 /);
  });

  it("warns about revenue on an account without a momsruta", async () => {
    const { user, yearId } = await setupYearEnd();
    await testEconomyService.createAccount({ number: "3899", name: "Övriga intäkter", vatBox: null });
    await bookManual(`${YEAR}-05-05`, [{ account: "1930", debit: 500 }, { account: "3899", credit: 500 }], user.id);
    const closing = await service.startClosing({ fiscalYearId: yearId }, user.id);
    const warning = (await service.getClosing(closing.id)).checks.warnings.find((w) => w.code === "revenue-without-vat-box");
    expect(warning!.message).toBe("Intäkter på konton utan momsruta: 3899 Övriga intäkter");
  });
});

// An approved supplier invoice with a real L-shaped verification: cost
// debited, the payable (2440) credited with the gross.
async function approvedSupplierInvoice(n: number, gross: number, date: string, userId: string) {
  const [supplier] = await db.insert(suppliers).values({ supplierNumber: `L-W${n}`, name: `Leverantör ${n} AB` }).returning();
  const booked = await bookManual(date, [{ account: "4010", debit: gross }, { account: "2440", credit: gross }], userId);
  const [invoice] = await db
    .insert(supplierInvoices)
    .values({
      registrationNumber: `LF-W${n}`,
      invoiceNumber: `W${n}`,
      supplierId: supplier!.id,
      vatCodeId: await vatCodeId("MP25"),
      invoiceDate: date,
      status: "approved",
      grossAmount: String(gross),
      verificationId: booked.id,
    })
    .returning();
  return invoice!;
}

describe("steg 1 — leverantörsavstämningen", () => {
  it("warns when an approved invoice's L verification is reversed by a manual Omför", async () => {
    const { user, yearId } = await setupYearEnd();
    const invoice = await approvedSupplierInvoice(1, 8000, `${YEAR}-11-01`, user.id);
    // Omför dates its draft today — pin today inside the year so the test
    // never depends on the calendar.
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date(`${YEAR}-12-10T10:00:00Z`));
    try {
      const draft = await testEconomyService.reverse(invoice.verificationId!, user.id);
      await testEconomyService.book(draft.id, user.id);
    } finally {
      vi.useRealTimers();
    }
    const closing = await service.startClosing({ fiscalYearId: yearId }, user.id);
    const warning = (await service.getClosing(closing.id)).checks.warnings.find((w) => w.code === "payables-mismatch");
    expect(warning!.message).toBe(
      `Leverantörsreskontran stämmer inte mot konto 2440: huvudbok ${formatNumber(0)}, reskontra ${formatNumber(8000)} (skillnad ${formatNumber(-8000)})`
    );
  });

  it("reconciles an invoice cancelled in the year next to an open one", async () => {
    const { user, yearId } = await setupYearEnd();
    await approvedSupplierInvoice(1, 2000, `${YEAR}-11-01`, user.id);
    const cancelled = await approvedSupplierInvoice(2, 1500, `${YEAR}-11-02`, user.id);
    // The legitimate cancellation: omföring + status flip in one transaction.
    await db.transaction(async (tx) => {
      await testYearEndPoster.reverseBookedVerification(tx, cancelled.verificationId!, { date: `${YEAR}-12-01`, description: "Makulering" }, user.id);
      await tx.update(supplierInvoices).set({ status: "cancelled" }).where(eq(supplierInvoices.id, cancelled.id));
    });
    const closing = await service.startClosing({ fiscalYearId: yearId }, user.id);
    const codes = (await service.getClosing(closing.id)).checks.warnings.map((w) => w.code);
    expect(codes).not.toContain("payables-mismatch");
  });

  it("measures both reskontror at the year's end, not at an earlier closing date", async () => {
    const { user, yearId } = await setupYearEnd();
    const closing = await service.startClosing({ fiscalYearId: yearId, closingDate: `${YEAR}-12-20` }, user.id);
    await bookManual(`${YEAR}-12-28`, [{ account: "1510", debit: 60 }, { account: "3001", credit: 60 }], user.id);
    await bookManual(`${YEAR}-12-29`, [{ account: "4010", debit: 40 }, { account: "2440", credit: 40 }], user.id);
    const codes = (await service.getClosing(closing.id)).checks.warnings.map((w) => w.code);
    expect(codes).toContain("receivables-mismatch");
    expect(codes).toContain("payables-mismatch");
  });
});

import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { and, asc, eq, sql } from "drizzle-orm";
import {
  accounts,
  articleGroups,
  db,
  suppliers,
  supplierInvoiceRows,
  supplierInvoices,
  verificationRows,
  verifications,
  verificationSeries,
} from "@navet/db";
import { createArticleRepository } from "../src/modules/article/repository/article.repository.js";
import { createArticleService } from "../src/modules/article/service/article.service.js";
import { createAuthRepository } from "../src/modules/auth/repository/auth.repository.js";
import { AccountingPeriodLockedError } from "../src/modules/economy/service/accounting-period-lock.js";
import {
  NonSekSupplierInvoiceError,
  SupplierInvoiceAmountMismatchError,
  createVerificationPoster,
} from "../src/modules/economy/service/verification-poster.js";
import { readPostingSettings } from "../src/modules/system/service/posting-settings.js";
import { createSupplierInvoiceRepository } from "../src/modules/purchase/repository/supplier-invoice.repository.js";
import {
  createSupplierInvoiceService,
  VerificationAlreadyReversedError,
  type SupplierInvoicePoster,
} from "../src/modules/purchase/service/supplier-invoice.service.js";
import {
  DEFAULT_POSTING_SETTINGS,
  POSTING_BASELINE_YEAR,
  setupPostingBaseline,
  testEconomyService,
  testSystemService,
} from "./helpers/services.js";
import { vatCodeId } from "./helpers/vat-codes.js";

// B2: approving a supplier invoice books an L verification inside the SAME
// transaction as the draft → approved flip, and cancelling an approved one
// books the mirrored omföring. This suite drives the real wiring end to end —
// the poster is constructed on the real readPostingSettings leaf (exactly as
// app.ts does), so the settings→accounts→verification path is the one
// production runs.
const articleService = createArticleService(createArticleRepository(db));
const authRepo = createAuthRepository(db);
const poster = createVerificationPoster({ read: readPostingSettings });
const invoiceService = createSupplierInvoiceService(createSupplierInvoiceRepository(db), poster);

// The real poster checks "is this already reversed?" before inserting, which
// cannot cover the case where a manual Omför commits between that check and
// the insert — only the partial unique index verifications_reverses_unique
// can. This poster skips the check and inserts anyway, which is exactly what
// that race looks like from inside the cancellation's transaction.
const racingReversalPoster: SupplierInvoicePoster = {
  postSupplierInvoice: poster.postSupplierInvoice,
  async reverseBookedVerification(tx, sourceVerificationId, opts, userId) {
    const [source] = await tx
      .select({ seriesId: verifications.seriesId, fiscalYearId: verifications.fiscalYearId })
      .from(verifications)
      .where(eq(verifications.id, sourceVerificationId));
    const [inserted] = await tx
      .insert(verifications)
      .values({
        seriesId: source!.seriesId,
        fiscalYearId: source!.fiscalYearId,
        verificationNumber: 9999,
        date: opts.date,
        description: opts.description,
        status: "booked",
        reversesVerificationId: sourceVerificationId,
        createdBy: userId,
        bookedBy: userId,
        bookedAt: new Date(),
      })
      .returning();
    return { verificationId: inserted!.id };
  },
};
const racingInvoiceService = createSupplierInvoiceService(
  createSupplierInvoiceRepository(db),
  racingReversalPoster
);

// number_series is NEVER truncated (shared, sequence-like base data) — every
// assertion below is relative to what the previous approval produced, never
// an absolute LF/verifikat number.
const TRUNCATE = sql`TRUNCATE posting_rules, verification_rows, verifications, verification_counters, verification_series, accounting_periods, fiscal_years, accounts, article_groups, supplier_invoice_rows, supplier_invoices, suppliers, articles, audit_log, users CASCADE`;

beforeEach(async () => {
  await db.execute(TRUNCATE);
  await setupPostingBaseline();
  // system_settings survives the truncate (it is shared base data), so the
  // posting roles are reset explicitly — a suite that ran earlier may have
  // pointed one of them somewhere else.
  await testSystemService.updateSettings({ ...DEFAULT_POSTING_SETTINGS });
});

afterAll(async () => {
  await db.execute(TRUNCATE);
  await testSystemService.updateSettings({ ...DEFAULT_POSTING_SETTINGS });
});

// The reversal is always dated "today"; the invoice date is what decides the
// posting period for the approval itself. A month that is NOT the current one
// lets a test lock exactly one of the two.
const TODAY = new Date().toLocaleDateString("sv-SE");
const OTHER_MONTH = Number(TODAY.slice(5, 7)) === 1 ? "02" : "01";
const OTHER_MONTH_DATE = `${POSTING_BASELINE_YEAR}-${OTHER_MONTH}-15`;

async function makeUser() {
  return authRepo.create({
    email: `ap-posting-${crypto.randomUUID()}@example.com`,
    passwordHash: "not-a-real-hash",
    name: "Attestant",
    role: "admin",
  });
}

async function makeSupplier(name = "Lev AB", currency = "SEK") {
  const [row] = await db
    .insert(suppliers)
    .values({ name, supplierNumber: `TEST-${crypto.randomUUID()}`, currency, active: true })
    .returning();
  return row!;
}

async function makeArticleGroup(code: string, name: string) {
  const [row] = await db.insert(articleGroups).values({ code, name }).returning();
  return row!;
}

async function makeArticle(groupId?: string) {
  return articleService.createArticle({
    articleNumber: `ART-AP-${crypto.randomUUID()}`,
    name: "Konteringsartikel",
    type: "purchased",
    active: true,
    ...(groupId !== undefined ? { groupId } : {}),
  });
}

type RowInput = {
  description: string;
  articleId?: string;
  quantity: number;
  unitPrice: number;
  vatRate?: number;
};

async function makeInvoice(
  supplierId: string,
  amounts: { netAmount: number; vatAmount: number; grossAmount: number },
  rows: RowInput[],
  userId: string,
  invoiceDate = TODAY
) {
  const invoice = await invoiceService.create(
    {
      supplierId,
      invoiceNumber: `INV-${crypto.randomUUID()}`,
      invoiceDate,
      ...amounts,
      rows,
    },
    userId
  );
  return invoice!;
}

async function accountId(number: string) {
  const [row] = await db.select({ id: accounts.id }).from(accounts).where(eq(accounts.number, number));
  return row!.id;
}

// A verification with its rows joined to account numbers, ordered the way the
// poster wrote them.
async function loadVerification(verificationId: string) {
  const [verification] = await db
    .select({
      id: verifications.id,
      seriesCode: verificationSeries.code,
      verificationNumber: verifications.verificationNumber,
      date: verifications.date,
      description: verifications.description,
      status: verifications.status,
      createdBy: verifications.createdBy,
      bookedBy: verifications.bookedBy,
      reversesVerificationId: verifications.reversesVerificationId,
    })
    .from(verifications)
    .innerJoin(verificationSeries, eq(verificationSeries.id, verifications.seriesId))
    .where(eq(verifications.id, verificationId));
  const rows = await db
    .select({ number: accounts.number, debit: verificationRows.debit, credit: verificationRows.credit })
    .from(verificationRows)
    .innerJoin(accounts, eq(accounts.id, verificationRows.accountId))
    .where(eq(verificationRows.verificationId, verificationId))
    .orderBy(asc(verificationRows.createdAt));
  return { ...verification!, rows };
}

// The verification a given supplier invoice booked.
async function verificationFor(invoiceId: string) {
  const [invoice] = await db.select().from(supplierInvoices).where(eq(supplierInvoices.id, invoiceId));
  if (!invoice?.verificationId) return null;
  return loadVerification(invoice.verificationId);
}

// The (single) verification pointing back at a source — the omföring.
async function reversalOf(sourceVerificationId: string) {
  const rows = await db
    .select({ id: verifications.id })
    .from(verifications)
    .where(eq(verifications.reversesVerificationId, sourceVerificationId));
  return rows.length === 0 ? null : loadVerification(rows[0]!.id);
}

// Every produced verification must balance and every row must be debit XOR
// credit — asserted on top of the per-test row expectations.
function expectBalanced(rows: { debit: string; credit: string }[]) {
  const debit = rows.reduce((sum, row) => sum + Number(row.debit), 0);
  const credit = rows.reduce((sum, row) => sum + Number(row.credit), 0);
  expect(debit).toBeCloseTo(credit, 2);
  for (const row of rows) {
    expect(Number(row.debit) === 0).not.toBe(Number(row.credit) === 0);
  }
}

// The accounting period covering a given date in the baseline fiscal year.
async function periodFor(fiscalYearId: string, date: string) {
  const year = await testEconomyService.findFiscalYearById(fiscalYearId);
  return year.periods.find((period) => period.startDate <= date && period.endDate >= date)!;
}

describe("leverantörsfaktura — automatkontering vid attest (B2)", () => {
  it("books an L verification with payable, incoming VAT, a rule cost row, an article-less row on the default account and the remainder", async () => {
    const user = await makeUser();
    const supplier = await makeSupplier();
    const group = await makeArticleGroup("2000", "Legoarbeten");
    const article = await makeArticle(group.id);
    await testEconomyService.createPostingRule({
      articleGroupId: group.id,
      vatCodeId: await vatCodeId("MP25"),
      revenueAccountId: null,
      costAccountId: await accountId("4600"),
    });

    // Rows explain 900 of the header's 1000 net; the remaining 100 (freight
    // on the paper invoice) lands on the default cost account, which the
    // article-less row already uses.
    const invoice = await makeInvoice(
      supplier.id,
      { netAmount: 1000, vatAmount: 250, grossAmount: 1250 },
      [
        { description: "Legobearbetning", articleId: article.id, quantity: 1, unitPrice: 800, vatRate: 25 },
        { description: "Frakt", quantity: 1, unitPrice: 100, vatRate: 25 },
      ],
      user.id
    );

    const approved = await invoiceService.approve(invoice.id, user.id);
    expect(approved!.status).toBe("approved");
    expect(approved!.verificationId).not.toBeNull();

    const verification = await verificationFor(invoice.id);
    expect(verification!.status).toBe("booked");
    expect(verification!.seriesCode).toBe("L");
    expect(verification!.date).toBe(invoice.invoiceDate);
    expect(verification!.description).toBe(
      `Leverantörsfaktura ${invoice.registrationNumber} (${invoice.invoiceNumber}) — Lev AB`
    );
    expect(verification!.createdBy).toBe(user.id);
    expect(verification!.bookedBy).toBe(user.id);
    expect(verification!.reversesVerificationId).toBeNull();

    expect(verification!.rows).toEqual([
      { number: "2440", debit: "0.00", credit: "1250.00" },
      { number: "2640", debit: "250.00", credit: "0.00" },
      { number: "4600", debit: "800.00", credit: "0.00" },
      { number: "4010", debit: "200.00", credit: "0.00" },
    ]);
    expectBalanced(verification!.rows);
  });

  it("gives a new invoice MP25 and books omvänd moms when the header and a row carry other momskoder", async () => {
    const user = await makeUser();
    const supplier = await makeSupplier();
    const invoice = await makeInvoice(
      supplier.id,
      { netAmount: 1000, vatAmount: 0, grossAmount: 1000 },
      [
        { description: "Material", quantity: 1, unitPrice: 600, vatRate: 25 },
        { description: "Montage", quantity: 1, unitPrice: 400, vatRate: 25 },
      ],
      user.id
    );
    const [stored] = await db.select().from(supplierInvoices).where(eq(supplierInvoices.id, invoice.id));
    expect(stored!.vatCodeId).toBe(await vatCodeId("MP25"));

    // The fields arrive with the documents step; set the codes directly here
    // to drive the approval's in-tx loading.
    await db.update(supplierInvoices).set({ vatCodeId: await vatCodeId("IEUV25") }).where(eq(supplierInvoices.id, invoice.id));
    await db
      .update(supplierInvoiceRows)
      .set({ vatCodeId: await vatCodeId("IEUT") })
      .where(and(eq(supplierInvoiceRows.supplierInvoiceId, invoice.id), eq(supplierInvoiceRows.description, "Montage")));

    await invoiceService.approve(invoice.id, user.id);
    const verification = await verificationFor(invoice.id);
    expect(verification!.rows).toEqual([
      { number: "2440", debit: "0.00", credit: "1000.00" },
      { number: "4515", debit: "600.00", credit: "0.00" },
      { number: "4535", debit: "400.00", credit: "0.00" },
      { number: "2614", debit: "0.00", credit: "250.00" },
      { number: "2645", debit: "250.00", credit: "0.00" },
    ]);
    expectBalanced(verification!.rows);
  });

  it("puts the whole net amount on the default cost account when the invoice has no rows", async () => {
    const user = await makeUser();
    const supplier = await makeSupplier();
    const invoice = await makeInvoice(
      supplier.id,
      { netAmount: 500, vatAmount: 125, grossAmount: 625 },
      [],
      user.id
    );

    await invoiceService.approve(invoice.id, user.id);

    const verification = await verificationFor(invoice.id);
    expect(verification!.rows).toEqual([
      { number: "2440", debit: "0.00", credit: "625.00" },
      { number: "2640", debit: "125.00", credit: "0.00" },
      { number: "4010", debit: "500.00", credit: "0.00" },
    ]);
    expectBalanced(verification!.rows);
  });

  it("refuses to approve when the header amounts do not add up and leaves the invoice in draft", async () => {
    const user = await makeUser();
    const supplier = await makeSupplier();
    const invoice = await makeInvoice(
      supplier.id,
      { netAmount: 100, vatAmount: 25, grossAmount: 200 },
      [{ description: "Material", quantity: 1, unitPrice: 100, vatRate: 25 }],
      user.id
    );

    await expect(invoiceService.approve(invoice.id, user.id)).rejects.toThrow(SupplierInvoiceAmountMismatchError);

    const stillDraft = await invoiceService.getInvoice(invoice.id);
    expect(stillDraft!.status).toBe("draft");
    expect(stillDraft!.verificationId).toBeNull();
    expect(await db.select().from(verifications)).toHaveLength(0);
  });

  it("refuses to approve a supplier invoice in another currency than SEK", async () => {
    const user = await makeUser();
    const supplier = await makeSupplier("Euro AB", "EUR");
    const invoice = await makeInvoice(
      supplier.id,
      { netAmount: 100, vatAmount: 25, grossAmount: 125 },
      [{ description: "Material", quantity: 1, unitPrice: 100, vatRate: 25 }],
      user.id
    );

    await expect(invoiceService.approve(invoice.id, user.id)).rejects.toThrow(NonSekSupplierInvoiceError);
    expect((await invoiceService.getInvoice(invoice.id))!.status).toBe("draft");
  });

  it("blocks the approval when the period covering the invoice date is locked, and burns no verification number", async () => {
    const user = await makeUser();
    const supplier = await makeSupplier();
    const { fiscalYearId } = await setupPostingBaseline();

    // A first approval establishes where the L series currently stands.
    const before = await makeInvoice(supplier.id, { netAmount: 100, vatAmount: 25, grossAmount: 125 }, [], user.id);
    await invoiceService.approve(before.id, user.id);
    const firstVerification = await verificationFor(before.id);

    const period = await periodFor(fiscalYearId, TODAY);
    await testEconomyService.lockPeriod(period.id, user.id);

    const blocked = await makeInvoice(supplier.id, { netAmount: 100, vatAmount: 25, grossAmount: 125 }, [], user.id);
    await expect(invoiceService.approve(blocked.id, user.id)).rejects.toThrow(AccountingPeriodLockedError);

    const stillDraft = await invoiceService.getInvoice(blocked.id);
    expect(stillDraft!.status).toBe("draft");
    expect(stillDraft!.verificationId).toBeNull();

    await testEconomyService.unlockPeriod(period.id, "Rättelse", user.id);
    await invoiceService.approve(blocked.id, user.id);
    const afterVerification = await verificationFor(blocked.id);
    // The blocked attempt rolled its number allocation back, so the series
    // continues unbroken.
    expect(afterVerification!.verificationNumber).toBe(firstVerification!.verificationNumber! + 1);
  });

  it("two concurrent approvals produce exactly one verification and one approved invoice", async () => {
    const user = await makeUser();
    const supplier = await makeSupplier();
    const invoice = await makeInvoice(supplier.id, { netAmount: 100, vatAmount: 25, grossAmount: 125 }, [], user.id);

    const results = await Promise.allSettled([
      invoiceService.approve(invoice.id, user.id),
      invoiceService.approve(invoice.id, user.id),
    ]);
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);

    const booked = await db.select().from(verifications);
    expect(booked).toHaveLength(1);

    const approved = await invoiceService.getInvoice(invoice.id);
    expect(approved!.status).toBe("approved");
    expect(approved!.verificationId).toBe(booked[0]!.id);

    // The loser's rollback returned its verifikatnummer.
    const next = await makeInvoice(supplier.id, { netAmount: 100, vatAmount: 25, grossAmount: 125 }, [], user.id);
    await invoiceService.approve(next.id, user.id);
    const nextVerification = await verificationFor(next.id);
    expect(nextVerification!.verificationNumber).toBe(booked[0]!.verificationNumber! + 1);
  });

  it("books a mirrored omföring when an approved invoice is cancelled", async () => {
    const user = await makeUser();
    const supplier = await makeSupplier();
    const invoice = await makeInvoice(
      supplier.id,
      { netAmount: 1000, vatAmount: 250, grossAmount: 1250 },
      [{ description: "Material", quantity: 1, unitPrice: 1000, vatRate: 25 }],
      user.id
    );
    await invoiceService.approve(invoice.id, user.id);
    const source = await verificationFor(invoice.id);

    const cancelled = await invoiceService.cancel(invoice.id, user.id);
    expect(cancelled!.status).toBe("cancelled");
    // The link to the original verification survives the cancellation.
    expect(cancelled!.verificationId).toBe(source!.id);

    const reversal = await reversalOf(source!.id);
    expect(reversal!.status).toBe("booked");
    expect(reversal!.seriesCode).toBe("L");
    expect(reversal!.date).toBe(TODAY);
    expect(reversal!.description).toBe(
      `Makulering ${invoice.registrationNumber} (${invoice.invoiceNumber}) — Lev AB`
    );
    expect(reversal!.rows).toEqual([
      { number: "2440", debit: "1250.00", credit: "0.00" },
      { number: "2640", debit: "0.00", credit: "250.00" },
      { number: "4010", debit: "0.00", credit: "1000.00" },
    ]);
    expectBalanced(reversal!.rows);
  });

  it("cancels without booking a second omföring when the verification was already reversed manually", async () => {
    const user = await makeUser();
    const supplier = await makeSupplier();
    const invoice = await makeInvoice(supplier.id, { netAmount: 100, vatAmount: 25, grossAmount: 125 }, [], user.id);
    await invoiceService.approve(invoice.id, user.id);
    const source = await verificationFor(invoice.id);

    // Somebody reversed it by hand under Ekonomi → Verifikat first — and
    // BOOKED that omföring, so the correction actually stands in the books.
    // Only then is skipping the poster's own omföring correct.
    const manual = await testEconomyService.reverse(source!.id, user.id);
    await testEconomyService.book(manual.id, user.id);

    const cancelled = await invoiceService.cancel(invoice.id, user.id);
    expect(cancelled!.status).toBe("cancelled");

    // Still exactly one reversal — the manual one.
    const reversals = await db
      .select({ id: verifications.id })
      .from(verifications)
      .where(eq(verifications.reversesVerificationId, source!.id));
    expect(reversals).toHaveLength(1);
    expect(reversals[0]!.id).toBe(manual.id);
    expect(await db.select().from(verifications)).toHaveLength(2);
  });

  // The dangerous variant of the test above: a manual Omför that was NEVER
  // booked is only a draft — deletable, outside the books, no correction at
  // all. Letting it satisfy the poster's "already reversed" check would
  // commit the cancellation with nothing booked against the L verification.
  it("refuses the cancellation when the only omföring of the verification is an unbooked draft", async () => {
    const user = await makeUser();
    const supplier = await makeSupplier();
    const invoice = await makeInvoice(supplier.id, { netAmount: 100, vatAmount: 25, grossAmount: 125 }, [], user.id);
    await invoiceService.approve(invoice.id, user.id);
    const source = await verificationFor(invoice.id);

    // Somebody clicked Omför under Ekonomi → Verifikat but never booked it.
    const draft = await testEconomyService.reverse(source!.id, user.id);
    expect((await testEconomyService.findVerificationById(draft.id)).status).toBe("draft");

    // The real poster (not the racing one): the draft falls through the
    // status-filtered pre-check and the unique index rejects the insert.
    await expect(invoiceService.cancel(invoice.id, user.id)).rejects.toThrow(VerificationAlreadyReversedError);

    // Nothing committed — the invoice is still approved and still points at
    // its original, untouched verification.
    const stillApproved = await invoiceService.getInvoice(invoice.id);
    expect(stillApproved!.status).toBe("approved");
    expect(stillApproved!.verificationId).toBe(source!.id);
    const stillBooked = await verificationFor(invoice.id);
    expect(stillBooked!.status).toBe("booked");
    expect(stillBooked!.rows).toEqual([
      { number: "2440", debit: "0.00", credit: "125.00" },
      { number: "2640", debit: "25.00", credit: "0.00" },
      { number: "4010", debit: "100.00", credit: "0.00" },
    ]);

    // Still exactly one (draft) reversal — no second one was written.
    const reversals = await db
      .select({ id: verifications.id, status: verifications.status })
      .from(verifications)
      .where(eq(verifications.reversesVerificationId, source!.id));
    expect(reversals).toEqual([{ id: draft.id, status: "draft" }]);

    // Booking the manual omföring is the way out: the cancellation then goes
    // through without a second omföring.
    await testEconomyService.book(draft.id, user.id);
    expect((await invoiceService.cancel(invoice.id, user.id))!.status).toBe("cancelled");
  });

  it("reports a conflict and keeps the invoice approved when a manual omföring wins the race", async () => {
    const user = await makeUser();
    const supplier = await makeSupplier();
    const invoice = await makeInvoice(supplier.id, { netAmount: 100, vatAmount: 25, grossAmount: 125 }, [], user.id);
    await invoiceService.approve(invoice.id, user.id);
    const source = await verificationFor(invoice.id);

    // A BOOKED manual Omför is already in the table — the real poster would
    // report alreadyReversed and skip (the test above), so only the racing
    // poster, which inserts its own reversal anyway, can reach the insert.
    // The unique index, not the poster's own check, is what stops it.
    const manual = await testEconomyService.reverse(source!.id, user.id);
    await testEconomyService.book(manual.id, user.id);
    await expect(racingInvoiceService.cancel(invoice.id, user.id)).rejects.toThrow(VerificationAlreadyReversedError);

    // Nothing committed: the invoice is untouched and no second reversal
    // exists.
    expect((await invoiceService.getInvoice(invoice.id))!.status).toBe("approved");
    const reversals = await db
      .select({ id: verifications.id })
      .from(verifications)
      .where(eq(verifications.reversesVerificationId, source!.id));
    expect(reversals).toHaveLength(1);
  });

  it("cancels an invoice approved before B2 (no verification) without posting anything", async () => {
    const user = await makeUser();
    const supplier = await makeSupplier();
    const invoice = await makeInvoice(supplier.id, { netAmount: 100, vatAmount: 25, grossAmount: 125 }, [], user.id);
    // The pre-B2 shape: approved with no verification link at all.
    await db.update(supplierInvoices).set({ status: "approved" }).where(eq(supplierInvoices.id, invoice.id));

    const cancelled = await invoiceService.cancel(invoice.id, user.id);
    expect(cancelled!.status).toBe("cancelled");
    expect(cancelled!.verificationId).toBeNull();
    expect(await db.select().from(verifications)).toHaveLength(0);
  });

  it("blocks the cancellation when the period covering the reversal date is locked", async () => {
    const user = await makeUser();
    const supplier = await makeSupplier();
    const { fiscalYearId } = await setupPostingBaseline();
    // Dated in another month so the approval itself stays possible while the
    // period covering "today" — the reversal's date — is locked.
    const invoice = await makeInvoice(
      supplier.id,
      { netAmount: 100, vatAmount: 25, grossAmount: 125 },
      [],
      user.id,
      OTHER_MONTH_DATE
    );
    await invoiceService.approve(invoice.id, user.id);
    const source = await verificationFor(invoice.id);

    const period = await periodFor(fiscalYearId, TODAY);
    await testEconomyService.lockPeriod(period.id, user.id);

    await expect(invoiceService.cancel(invoice.id, user.id)).rejects.toThrow(AccountingPeriodLockedError);

    const stillApproved = await invoiceService.getInvoice(invoice.id);
    expect(stillApproved!.status).toBe("approved");
    expect(await reversalOf(source!.id)).toBeNull();
  });

  // The two "pay"/"concurrent pays" cases that stood here are gone with the
  // transition itself (B4): "paid" is now a side effect of registering a
  // payment, and its races are covered where that registration lives.

  it("exposes the verification's display number on the detail GET and in the list, and null on a draft", async () => {
    const user = await makeUser();
    const supplier = await makeSupplier();
    const invoice = await makeInvoice(supplier.id, { netAmount: 100, vatAmount: 25, grossAmount: 125 }, [], user.id);

    const draft = await invoiceService.getInvoice(invoice.id);
    expect(draft!.verificationId).toBeNull();
    expect(draft!.verificationDisplayNumber).toBeNull();

    const approved = await invoiceService.approve(invoice.id, user.id);
    const verification = await verificationFor(invoice.id);
    const expected = `L-${POSTING_BASELINE_YEAR}-${verification!.verificationNumber}`;
    expect(approved!.verificationDisplayNumber).toBe(expected);

    const listed = await invoiceService.list({ limit: 50, offset: 0 });
    expect(listed.rows.find((row) => row.id === invoice.id)!.verificationDisplayNumber).toBe(expected);
  });
});

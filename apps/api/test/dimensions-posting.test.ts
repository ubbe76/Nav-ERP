import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { asc, eq, sql } from "drizzle-orm";
import { accounts, articleGroups, costCenters, customers, db, projects, salesOrderRows, salesOrders, suppliers, verificationRows, verifications } from "@navet/db";
import { createArticleRepository } from "../src/modules/article/repository/article.repository.js";
import { createArticleService } from "../src/modules/article/service/article.service.js";
import { createAlertsRepository } from "../src/modules/alerts/repository/alerts.repository.js";
import { createAlertsService } from "../src/modules/alerts/service/alerts.service.js";
import { createAuthRepository } from "../src/modules/auth/repository/auth.repository.js";
import { CostCenterRequiredError } from "../src/modules/economy/service/dimension-check.js";
import { createVerificationPoster } from "../src/modules/economy/service/verification-poster.js";
import { readPostingSettings } from "../src/modules/system/service/posting-settings.js";
import { createInvoiceRepository } from "../src/modules/sales/repository/invoice.repository.js";
import { createInvoiceService } from "../src/modules/sales/service/invoice.service.js";
import { createSupplierInvoiceRepository } from "../src/modules/purchase/repository/supplier-invoice.repository.js";
import { createSupplierInvoiceService } from "../src/modules/purchase/service/supplier-invoice.service.js";
import { DEFAULT_POSTING_SETTINGS, setupPostingBaseline, testEconomyService, testSystemService } from "./helpers/services.js";
import { FIXED_ASSET_TRUNCATE, RESET_ASSET_SERIES, PLAN_YEAR, accountId as basAccountId, setupFixedAssets, testFixedAssetService } from "./helpers/fixed-assets.js";

// Kostnadsställen och projekt in the bookkeeping (etapp 5 del A), against
// Postgres: the poster puts the objects on the revenue row of a customer
// invoice (default: the order header, else the article group) and on the
// cost rows of a supplier invoice (the header = the rows' default and the
// remainder's), the depreciation expense row takes the tillgångsgrupp's
// default, a reversal mirrors them, and Kräver kostnadsställe refuses a
// manual Bokför (409) but never a document — the row is booked without and
// shows up as a warning and in the alert.

const articleService = createArticleService(createArticleRepository(db));
const authRepo = createAuthRepository(db);
const poster = createVerificationPoster({ read: readPostingSettings });
const mailStub = { async sendMail() { return null; } };
const pdfStub = { async render() { return Buffer.alloc(0); }, async renderPaymentReminder() { return Buffer.alloc(0); } };
const invoiceService = createInvoiceService(createInvoiceRepository(db), mailStub, pdfStub, poster);
const supplierInvoiceService = createSupplierInvoiceService(createSupplierInvoiceRepository(db), poster);
const alertsRepo = createAlertsRepository(db);

const TRUNCATE = sql`TRUNCATE fixed_asset_depreciations, fixed_asset_depreciation_runs, fixed_assets, fixed_asset_categories, posting_rules, verification_rows, verifications, verification_counters, verification_series, accounting_periods, fiscal_years, accounts, article_groups, invoice_rows, invoices, sales_order_rows, sales_orders, customers, supplier_invoice_rows, supplier_invoices, suppliers, articles, cost_centers, projects, audit_log, users CASCADE`;

beforeEach(async () => {
  await db.execute(TRUNCATE);
  await db.execute(FIXED_ASSET_TRUNCATE);
  await db.execute(RESET_ASSET_SERIES);
  await setupPostingBaseline();
  await testSystemService.updateSettings({ ...DEFAULT_POSTING_SETTINGS });
});
afterAll(async () => {
  await db.execute(TRUNCATE);
  await db.execute(FIXED_ASSET_TRUNCATE);
  await testSystemService.updateSettings({ ...DEFAULT_POSTING_SETTINGS });
});

const TODAY = new Date().toLocaleDateString("sv-SE");

async function makeUser() {
  return authRepo.create({ email: `dimpost-${crypto.randomUUID()}@example.com`, passwordHash: "x", name: "Ekonom", role: "admin" });
}

async function makeCostCenter(code: string, name: string) {
  const [row] = await db.insert(costCenters).values({ code, name }).returning();
  return row!;
}

async function makeProject(code: string, name: string) {
  const [row] = await db.insert(projects).values({ code, name }).returning();
  return row!;
}

async function makeCustomer() {
  const [row] = await db.insert(customers).values({ name: "Kund AB", customerNumber: `K-${crypto.randomUUID().slice(0, 8)}`, active: true }).returning();
  return row!;
}

async function makeSupplier(defaultCostCenterId: string | null = null) {
  const [row] = await db
    .insert(suppliers)
    .values({ name: "Lev AB", supplierNumber: `L-${crypto.randomUUID().slice(0, 8)}`, currency: "SEK", active: true, defaultCostCenterId })
    .returning();
  return row!;
}

async function makeArticle(groupId?: string, type: "manufactured" | "purchased" = "manufactured") {
  return articleService.createArticle({ articleNumber: `ART-${crypto.randomUUID()}`, name: "Artikel", type, active: true, ...(groupId ? { groupId } : {}) });
}

// The booked verification's rows with account numbers and object codes.
async function rowsOf(verificationId: string) {
  const rows = await db
    .select({ number: accounts.number, debit: verificationRows.debit, credit: verificationRows.credit, costCenterId: verificationRows.costCenterId, projectId: verificationRows.projectId })
    .from(verificationRows)
    .innerJoin(accounts, eq(accounts.id, verificationRows.accountId))
    .where(eq(verificationRows.verificationId, verificationId))
    .orderBy(asc(verificationRows.createdAt));
  return rows.map((r) => ({ number: r.number, debit: Number(r.debit), credit: Number(r.credit), costCenterId: r.costCenterId, projectId: r.projectId }));
}

async function setCostCenterRequired(number: string, required: boolean) {
  await db.update(accounts).set({ costCenterRequired: required }).where(eq(accounts.number, number));
}

describe("Kräver kostnadsställe", () => {
  it("refuses Bokför of a manual verification whose row on such an account carries no cost center, naming the accounts", async () => {
    const user = await makeUser();
    const series = await testEconomyService.createSeries({ code: "A", name: "Manuella" });
    await setCostCenterRequired("5010", true);
    const workshop = await makeCostCenter("100", "Verkstad");
    const rent = (await db.select().from(accounts).where(eq(accounts.number, "5010")))[0]!;
    const bank = (await db.select().from(accounts).where(eq(accounts.number, "1930")))[0]!;

    // A draft is fine without — the rule bites at Bokför.
    const draft = await testEconomyService.createVerification(
      { seriesId: series.id, date: TODAY, description: "Hyra", rows: [{ accountId: rent.id, debit: 100, credit: 0 }, { accountId: bank.id, debit: 0, credit: 100 }], book: false },
      user.id
    );
    expect(draft.status).toBe("draft");
    await expect(testEconomyService.book(draft.id, user.id)).rejects.toMatchObject({ name: "CostCenterRequiredError", accounts: ["5010"] });
    expect((await testEconomyService.findVerificationById(draft.id)).status).toBe("draft");
    // Spara och bokför in one go: same refusal, nothing created.
    await expect(
      testEconomyService.createVerification(
        { seriesId: series.id, date: TODAY, description: "Hyra", rows: [{ accountId: rent.id, debit: 100, credit: 0 }, { accountId: bank.id, debit: 0, credit: 100 }], book: true },
        user.id
      )
    ).rejects.toBeInstanceOf(CostCenterRequiredError);
    expect((await db.select().from(verifications)).length).toBe(1);

    // With the cost center on the row it books.
    await testEconomyService.replaceRows(draft.id, [
      { accountId: rent.id, debit: 100, credit: 0, costCenterId: workshop.id },
      { accountId: bank.id, debit: 0, credit: 100 },
    ]);
    const booked = await testEconomyService.book(draft.id, user.id);
    expect(booked.status).toBe("booked");
    expect(booked.warnings).toEqual([]);
  });

  it("never refuses a customer invoice: the revenue row is booked without, the card warns and the alert lists it", async () => {
    const user = await makeUser();
    const customer = await makeCustomer();
    await setCostCenterRequired("3001", true);
    const draft = await invoiceService.create({ customerId: customer.id, rows: [{ description: "Arvode", quantity: 1, unitPrice: 1000, vatRate: 25 }] }, user.id);
    const issued = await invoiceService.issue(draft!.id, user.id);
    expect(issued!.status).toBe("issued");

    const detail = await testEconomyService.findVerificationById(issued!.verificationId!);
    expect(detail.status).toBe("booked");
    expect(detail.warnings).toEqual(["Konto 3001 Försäljning inom Sverige 25 % kräver kostnadsställe — raden saknar det"]);

    const missing = await alertsRepo.verificationsMissingCostCenter();
    expect(missing).toHaveLength(1);
    expect(missing[0]).toMatchObject({ verificationId: issued!.verificationId, accountNumbers: ["3001"] });
    const alerts = createAlertsService({
      repo: alertsRepo,
      planning: { requirementProposals: async () => [], orderPlanSummaries: async () => new Map() },
      settings: { supplierInvoiceDays: async () => 7, quoteFollowupDays: async () => 7 },
      today: () => TODAY,
    });
    const response = await alerts.alertsForUser({ role: "admin", permissions: [] });
    const group = response.groups.find((g) => g.kind === "cost_center_missing");
    expect(group).toMatchObject({ label: "Bokningar utan kostnadsställe", severity: "yellow", count: 1, listHref: "/ekonomi/verifikat" });
    expect(group!.items[0]).toMatchObject({ key: issued!.verificationId, href: `/ekonomi/verifikat/${issued!.verificationId}`, secondary: "Konto 3001 kräver kostnadsställe" });

    // Derived, never stored: dropping the flag empties the alert and the warning.
    await setCostCenterRequired("3001", false);
    expect(await alertsRepo.verificationsMissingCostCenter()).toEqual([]);
    expect((await testEconomyService.findVerificationById(issued!.verificationId!)).warnings).toEqual([]);
  });
});

describe("kundfaktura — the objects on the revenue row", () => {
  it("takes the order header's cost center and project for a linked row, the article group's default for a free row, and books them on the revenue row only", async () => {
    const user = await makeUser();
    const customer = await makeCustomer();
    const workshop = await makeCostCenter("100", "Verkstad");
    const office = await makeCostCenter("300", "Kontor");
    const project = await makeProject("P1", "Storköket");
    const [group] = await db.insert(articleGroups).values({ code: "100", name: "Tjänster", defaultCostCenterId: office.id }).returning();
    const linkedArticle = await makeArticle();
    const groupArticle = await makeArticle(group!.id);
    const [order] = await db
      .insert(salesOrders)
      .values({ orderNumber: `KO-${crypto.randomUUID().slice(0, 8)}`, customerId: customer.id, status: "delivered", costCenterId: workshop.id, projectId: project.id })
      .returning();
    const [orderRow] = await db
      .insert(salesOrderRows)
      .values({ salesOrderId: order!.id, articleId: linkedArticle.id, quantityOrdered: "2", quantityDelivered: "2", unitPrice: "500" })
      .returning();

    const draft = await invoiceService.create(
      {
        customerId: customer.id,
        rows: [
          { description: "Orderrad", articleId: linkedArticle.id, salesOrderRowId: orderRow!.id, quantity: 2, unitPrice: 500, vatRate: 25 },
          { description: "Grupprad", articleId: groupArticle.id, quantity: 1, unitPrice: 100, vatRate: 25 },
          { description: "Fri rad", quantity: 1, unitPrice: 50, vatRate: 25 },
        ],
      },
      user.id
    );
    const rows = draft!.rows;
    expect(rows[0]!.costCenter).toEqual({ id: workshop.id, code: "100", name: "Verkstad" });
    expect(rows[0]!.project).toEqual({ id: project.id, code: "P1", name: "Storköket" });
    expect(rows[1]!.costCenter).toEqual({ id: office.id, code: "300", name: "Kontor" });
    expect(rows[1]!.project).toBeNull();
    expect(rows[2]!.costCenter).toBeNull();

    // An explicit choice on a row wins over the default, null clears it.
    const patched = await invoiceService.updateRow(draft!.id, rows[1]!.id, { costCenterId: workshop.id, projectId: project.id }, user.id);
    expect(patched.costCenterId).toBe(workshop.id);
    expect(patched.projectId).toBe(project.id);
    const cleared = await invoiceService.updateRow(draft!.id, rows[1]!.id, { costCenterId: null }, user.id);
    expect(cleared.costCenterId).toBeNull();
    expect(cleared.projectId).toBe(project.id);

    const issued = await invoiceService.issue(draft!.id, user.id);
    const booked = await rowsOf(issued!.verificationId!);
    // 1510 and 2610 carry nothing; one revenue row per (account, objects).
    // The accumulator keeps the order the document was walked (the VAT row
    // is created with the first revenue row), so compare as a set.
    const byAmount = (a: { credit: number; number: string }, b: { credit: number; number: string }) => a.number.localeCompare(b.number) || a.credit - b.credit;
    expect([...booked].sort(byAmount)).toEqual(
      [
        { number: "1510", debit: 1437.5, credit: 0, costCenterId: null, projectId: null },
        { number: "3001", debit: 0, credit: 1000, costCenterId: workshop.id, projectId: project.id },
        { number: "3001", debit: 0, credit: 100, costCenterId: null, projectId: project.id },
        { number: "3001", debit: 0, credit: 50, costCenterId: null, projectId: null },
        { number: "2610", debit: 0, credit: 287.5, costCenterId: null, projectId: null },
      ].sort(byAmount)
    );

    // The credit note copies the rows' objects and mirrors them.
    const credit = await invoiceService.createCredit(issued!.id, {}, user.id);
    expect(credit!.rows[0]!.costCenter?.id).toBe(workshop.id);
    const creditIssued = await invoiceService.issue(credit!.id, user.id);
    const mirrored = await rowsOf(creditIssued!.verificationId!);
    expect(mirrored.find((r) => r.number === "3001" && r.costCenterId === workshop.id)).toMatchObject({ debit: 1000, credit: 0, projectId: project.id });
  });

  it("defaults per field: the article group's cost center fills in when the order header has none, the project is the header's only", async () => {
    const user = await makeUser();
    const customer = await makeCustomer();
    const office = await makeCostCenter("300", "Kontor");
    const project = await makeProject("P1", "Storköket");
    const [group] = await db.insert(articleGroups).values({ code: "100", name: "Tjänster", defaultCostCenterId: office.id }).returning();
    const article = await makeArticle(group!.id);
    const [order] = await db
      .insert(salesOrders)
      .values({ orderNumber: `KO-${crypto.randomUUID().slice(0, 8)}`, customerId: customer.id, status: "delivered", projectId: project.id })
      .returning();
    const [orderRow] = await db.insert(salesOrderRows).values({ salesOrderId: order!.id, articleId: article.id, quantityOrdered: "1", quantityDelivered: "1", unitPrice: "500" }).returning();

    const draft = await invoiceService.create(
      { customerId: customer.id, rows: [{ description: "Orderrad", articleId: article.id, salesOrderRowId: orderRow!.id, quantity: 1, unitPrice: 500, vatRate: 25 }] },
      user.id
    );
    expect(draft!.rows[0]!.costCenter?.id).toBe(office.id);
    expect(draft!.rows[0]!.project?.id).toBe(project.id);
    // An explicit null on the row beats the group default.
    const none = await invoiceService.updateRow(draft!.id, draft!.rows[0]!.id, { costCenterId: null }, user.id);
    expect(none.costCenterId).toBeNull();
    expect(none.projectId).toBe(project.id);
  });

  it("a credit note's rows override keeps the copied source objects unchecked, but holds a differing override to the rule", async () => {
    const user = await makeUser();
    const customer = await makeCustomer();
    const workshop = await makeCostCenter("100", "Verkstad");
    const project = await makeProject("P1", "Storköket");
    const other = await makeProject("P2", "Annat");
    const article = await makeArticle();
    const [order] = await db
      .insert(salesOrders)
      .values({ orderNumber: `KO-${crypto.randomUUID().slice(0, 8)}`, customerId: customer.id, status: "delivered", costCenterId: workshop.id, projectId: project.id })
      .returning();
    // Ten invoiced, so the four one-piece credit drafts below never over-credit.
    const [orderRow] = await db.insert(salesOrderRows).values({ salesOrderId: order!.id, articleId: article.id, quantityOrdered: "10", quantityDelivered: "10", unitPrice: "500" }).returning();
    const draft = await invoiceService.create(
      { customerId: customer.id, rows: [{ description: "Orderrad", articleId: article.id, salesOrderRowId: orderRow!.id, quantity: 10, unitPrice: 500, vatRate: 25 }] },
      user.id
    );
    const issued = await invoiceService.issue(draft!.id, user.id);
    // The project closes after the invoice went out.
    await db.update(projects).set({ status: "closed" }).where(eq(projects.id, project.id));

    const linked = { articleId: article.id, salesOrderRowId: orderRow!.id, description: "Kredit", quantity: 1, unitPrice: 500 };
    // Copied from the source (even with an explicit momskod on the override): kept, not re-checked.
    const copied = await invoiceService.createCredit(issued!.id, { rows: [{ ...linked, vatCodeId: issued!.rows[0]!.vatCodeId }] }, user.id);
    expect(copied!.rows[0]!.costCenter?.id).toBe(workshop.id);
    expect(copied!.rows[0]!.project?.id).toBe(project.id);
    // The same objects named explicitly are still the source's — kept too.
    const same = await invoiceService.createCredit(issued!.id, { rows: [{ ...linked, costCenterId: workshop.id, projectId: project.id }] }, user.id);
    expect(same!.rows[0]!.project?.id).toBe(project.id);
    // A differing override is the user's choice: a closed project is refused, null clears.
    await db.update(projects).set({ status: "closed" }).where(eq(projects.id, other.id));
    await expect(invoiceService.createCredit(issued!.id, { rows: [{ ...linked, projectId: other.id }] }, user.id)).rejects.toMatchObject({ name: "ProjectClosedError" });
    const cleared = await invoiceService.createCredit(issued!.id, { rows: [{ ...linked, projectId: null, costCenterId: null }] }, user.id);
    expect(cleared!.rows[0]!.project).toBeNull();
    expect(cleared!.rows[0]!.costCenter).toBeNull();
  });
});

describe("leverantörsfaktura — the objects on the cost rows", () => {
  it("defaults the header to the supplier's cost center, a row to the article group's, and books the remainder on the header's", async () => {
    const user = await makeUser();
    const workshop = await makeCostCenter("100", "Verkstad");
    const assembly = await makeCostCenter("200", "Montering");
    const project = await makeProject("P1", "Storköket");
    const supplier = await makeSupplier(workshop.id);
    const [group] = await db.insert(articleGroups).values({ code: "400", name: "Material", defaultCostCenterId: assembly.id }).returning();
    const article = await makeArticle(group!.id, "purchased");

    const invoice = await supplierInvoiceService.create(
      {
        supplierId: supplier.id,
        invoiceNumber: "F-1",
        invoiceDate: TODAY,
        netAmount: 1000,
        vatAmount: 250,
        grossAmount: 1250,
        projectId: project.id,
        rows: [
          { description: "Material", articleId: article.id, quantity: 1, unitPrice: 600 },
          { description: "Frakt", quantity: 1, unitPrice: 300 },
        ],
      },
      user.id
    );
    expect(invoice!.costCenter).toEqual({ id: workshop.id, code: "100", name: "Verkstad" });
    expect(invoice!.project).toEqual({ id: project.id, code: "P1", name: "Storköket" });
    expect(invoice!.rows[0]!.costCenter).toEqual({ id: assembly.id, code: "200", name: "Montering" });
    expect(invoice!.rows[0]!.project).toBeNull();
    expect(invoice!.rows[1]!.costCenter).toBeNull();

    const approved = await supplierInvoiceService.approve(invoice!.id, user.id);
    const booked = await rowsOf(approved!.verificationId!);
    // Material row: its own cost center, the header's project. Freight row
    // and the 100 kr remainder: the header's objects; 2440/2640 none.
    expect(booked.find((r) => r.number === "2440")).toMatchObject({ credit: 1250, costCenterId: null, projectId: null });
    expect(booked.find((r) => r.number === "2640")).toMatchObject({ debit: 250, costCenterId: null, projectId: null });
    const costRows = booked.filter((r) => r.number === "4010");
    expect(costRows).toEqual([
      { number: "4010", debit: 600, credit: 0, costCenterId: assembly.id, projectId: project.id },
      { number: "4010", debit: 400, credit: 0, costCenterId: workshop.id, projectId: project.id },
    ]);

    // Makulering books the mirrored omföring with the same objects.
    const cancelled = await supplierInvoiceService.cancel(invoice!.id, user.id);
    expect(cancelled!.status).toBe("cancelled");
    const [reversal] = await db.select().from(verifications).where(eq(verifications.reversesVerificationId, approved!.verificationId!));
    const mirrored = await rowsOf(reversal!.id);
    expect(mirrored.filter((r) => r.number === "4010")).toEqual([
      { number: "4010", debit: 0, credit: 600, costCenterId: assembly.id, projectId: project.id },
      { number: "4010", debit: 0, credit: 400, costCenterId: workshop.id, projectId: project.id },
    ]);
  });

  it("the header PATCH keeps omitted objects, clears with null, and a new purchase order link brings its project when the invoice has none", async () => {
    const user = await makeUser();
    const workshop = await makeCostCenter("100", "Verkstad");
    const project = await makeProject("P1", "Storköket");
    const supplier = await makeSupplier(null);
    const invoice = await supplierInvoiceService.create(
      { supplierId: supplier.id, invoiceNumber: "F-2", invoiceDate: TODAY, netAmount: 100, vatAmount: 25, grossAmount: 125, costCenterId: workshop.id, rows: [] },
      user.id
    );
    expect(invoice!.costCenterId).toBe(workshop.id);
    const kept = await supplierInvoiceService.updateHeader(invoice!.id, { note: "x" }, user.id);
    expect(kept!.costCenterId).toBe(workshop.id);
    const cleared = await supplierInvoiceService.updateHeader(invoice!.id, { costCenterId: null, projectId: project.id }, user.id);
    expect(cleared!.costCenterId).toBeNull();
    expect(cleared!.project?.id).toBe(project.id);
  });
});

describe("avskrivningar — the tillgångsgrupp's Kostnadsställe (förval)", () => {
  it("puts the group's cost center on the expense row and nothing on the ack row", async () => {
    const workshop = await makeCostCenter("100", "Verkstad");
    const { user, category } = await setupFixedAssets();
    await testFixedAssetService.updateCategory(category.id, { defaultCostCenterId: workshop.id });
    await testFixedAssetService.createAsset(
      { name: "CNC-fräs", categoryId: category.id, acquisitionDate: `${PLAN_YEAR}-02-14`, acquisitionCost: 120000, residualValue: 0, usefulLifeMonths: 60 },
      user.id
    );
    const run = await testFixedAssetService.bookDepreciation({ throughMonth: `${PLAN_YEAR}-06` }, user.id);
    const booked = await rowsOf(run.verification.id);
    expect(booked).toEqual([
      { number: "7830", debit: 10000, credit: 0, costCenterId: workshop.id, projectId: null },
      { number: "1229", debit: 0, credit: 10000, costCenterId: null, projectId: null },
    ]);
    expect(await basAccountId("7830")).toBeTruthy();
  });
});

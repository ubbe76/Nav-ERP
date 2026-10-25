import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import { costCenters, customers, db, projects, salesOrderRows, salesOrders } from "@navet/db";
import { createArticleRepository } from "../src/modules/article/repository/article.repository.js";
import { createArticleService } from "../src/modules/article/service/article.service.js";
import { createAuthRepository } from "../src/modules/auth/repository/auth.repository.js";
import { createEconomyRepository } from "../src/modules/economy/repository/economy.repository.js";
import { createEconomyService } from "../src/modules/economy/service/economy.service.js";
import { BAS_STANDARD_ACCOUNTS } from "../src/modules/economy/service/bas-accounts.js";
import { buildGroupedIncomeStatementCsv } from "../src/modules/economy/service/financial-reports-csv.js";
import { buildGroupedIncomeStatement, createFinancialReportsService } from "../src/modules/economy/service/financial-reports.service.js";
import { createProjectReportRepository } from "../src/modules/reports/repository/project-report.repository.js";
import { buildProjectReport } from "../src/modules/reports/service/project-report.js";
import { createProjectReportService, ProjectNotFoundError } from "../src/modules/reports/service/project-report.service.js";

// Resultaträkningen per objekt, huvudboken och verifikationslistan with the
// object filter, and the projektrapport — against Postgres, over four booked
// manual verifications that carry cost centers and a project.

const repo = createEconomyRepository(db);
const authRepo = createAuthRepository(db);
const economy = createEconomyService(repo, { log: async () => {} });
const reports = createFinancialReportsService({ db, repo });
const projectReport = createProjectReportService(createProjectReportRepository(db));
const articleService = createArticleService(createArticleRepository(db));

const TRUNCATE = sql`TRUNCATE sales_order_rows, sales_orders, customers, articles, verification_rows, verifications, verification_counters, verification_series, accounting_periods, fiscal_years, accounts, cost_centers, projects, audit_log, users CASCADE`;

beforeEach(async () => {
  await db.execute(TRUNCATE);
});
afterAll(async () => {
  await db.execute(TRUNCATE);
});

const YEAR = 2027;

async function setup() {
  const user = await authRepo.create({ email: `dimrep-${crypto.randomUUID()}@example.com`, passwordHash: "x", name: "Ekonom", role: "admin" });
  await economy.createFiscalYear({ label: String(YEAR), startDate: `${YEAR}-01-01`, endDate: `${YEAR}-12-31` });
  const series = await economy.createSeries({ code: "A", name: "Manuella verifikat" });
  await repo.seedAccounts(BAS_STANDARD_ACCOUNTS);
  const [workshop] = await db.insert(costCenters).values({ code: "100", name: "Verkstad" }).returning();
  const [assembly] = await db.insert(costCenters).values({ code: "200", name: "Montering" }).returning();
  const [project] = await db.insert(projects).values({ code: "P1", name: "Storköket" }).returning();
  const account = async (number: string) => (await repo.findAccountByNumber(number))!.id;
  const book = async (date: string, description: string, rows: { number: string; net: number; costCenterId?: string; projectId?: string }[]) =>
    economy.createVerification(
      {
        seriesId: series.id,
        date,
        description,
        rows: await Promise.all(
          rows.map(async (r) => ({
            accountId: await account(r.number),
            debit: r.net > 0 ? r.net : 0,
            credit: r.net < 0 ? -r.net : 0,
            ...(r.costCenterId ? { costCenterId: r.costCenterId } : {}),
            ...(r.projectId ? { projectId: r.projectId } : {}),
          }))
        ),
        book: true,
      },
      user.id
    );
  const v1 = await book(`${YEAR}-02-10`, "Försäljning", [
    { number: "1930", net: 1000 },
    { number: "3001", net: -1000, costCenterId: workshop!.id, projectId: project!.id },
  ]);
  await book(`${YEAR}-02-12`, "Hyra montering", [
    { number: "5010", net: 300, costCenterId: assembly!.id },
    { number: "1930", net: -300 },
  ]);
  const v3 = await book(`${YEAR}-03-05`, "Hyra verkstad", [
    { number: "5010", net: 200, costCenterId: workshop!.id, projectId: project!.id },
    { number: "1930", net: -200 },
  ]);
  await book(`${YEAR}-03-06`, "Kontorsmaterial", [
    { number: "6110", net: 50 },
    { number: "1930", net: -50 },
  ]);
  return { user, workshop: workshop!, assembly: assembly!, project: project!, v1, v3, account };
}

const RANGE = { from: `${YEAR}-01-01`, to: `${YEAR}-12-31` };

describe("resultaträkningen", () => {
  it("filters on a cost center with the ungrouped shape", async () => {
    const { workshop } = await setup();
    const all = await reports.getIncomeStatement(RANGE);
    expect(all.result).toBe(450);
    expect(all.columns).toBeUndefined();

    const filtered = await reports.getIncomeStatement({ ...RANGE, costCenterId: workshop.id });
    expect(filtered.result).toBe(800);
    expect(filtered.columns).toBeUndefined();
    const accounts = filtered.entries.flatMap((e) => (e.kind === "line" ? e.accounts.map((a) => [a.accountNumber, a.amount]) : []));
    expect(accounts).toEqual([
      ["3001", 1000],
      ["5010", -200],
    ]);
  });

  it("groups per cost center: one column per object with movement plus Utan, amounts per line, account and subtotal that sum to the total", async () => {
    const { workshop, assembly } = await setup();
    const grouped = await reports.getIncomeStatement({ ...RANGE, groupBy: "costCenter" });
    expect(grouped.columns).toEqual([
      { id: workshop.id, code: "100", name: "Verkstad" },
      { id: assembly.id, code: "200", name: "Montering" },
      { id: null, code: null, name: "Utan" },
    ]);
    expect(grouped.result).toBe(450);
    const revenue = grouped.entries.find((e) => e.kind === "line" && e.accounts.some((a) => a.accountNumber === "3001"))!;
    expect(revenue.amounts).toEqual([1000, 0, 0]);
    const rent = grouped.entries.flatMap((e) => (e.kind === "line" ? e.accounts : [])).find((a) => a.accountNumber === "5010")!;
    expect(rent.amount).toBe(-500);
    expect(rent.amounts).toEqual([-200, -300, 0]);
    const office = grouped.entries.flatMap((e) => (e.kind === "line" ? e.accounts : [])).find((a) => a.accountNumber === "6110")!;
    expect(office.amounts).toEqual([0, 0, -50]);
    const last = [...grouped.entries].reverse().find((e) => e.kind === "subtotal")!;
    expect(last.total).toBe(450);
    expect(last.amounts).toEqual([800, -300, -50]);
    for (const entry of grouped.entries) {
      expect(entry.amounts!.reduce((sum, a) => sum + a, 0)).toBeCloseTo(entry.total, 2);
    }

    const csv = buildGroupedIncomeStatementCsv(grouped, grouped.columns!);
    expect(csv.split("\n")[0]).toContain("Konto;Benämning;100 Verkstad;200 Montering;Utan;Totalt");
    expect(csv).toContain("5010;Lokalhyra;-200,00;-300,00;0,00;-500,00");
  });

  it("groups per project and combines the filter with the grouping", async () => {
    const { project, workshop } = await setup();
    const grouped = await reports.getIncomeStatement({ ...RANGE, groupBy: "project" });
    expect(grouped.columns).toEqual([
      { id: project.id, code: "P1", name: "Storköket" },
      { id: null, code: null, name: "Utan" },
    ]);
    const last = [...grouped.entries].reverse().find((e) => e.kind === "subtotal")!;
    expect(last.amounts).toEqual([800, -350]);
    // Filtered to the workshop, every row carries P1 — no Utan column.
    const both = await reports.getIncomeStatement({ ...RANGE, groupBy: "project", costCenterId: workshop.id });
    expect(both.columns).toEqual([{ id: project.id, code: "P1", name: "Storköket" }]);
    expect(both.result).toBe(800);
  });
});

describe("buildGroupedIncomeStatement (pure)", () => {
  const balance = (accountNumber: string, objectId: string | null, net: number) => ({
    accountId: `acc-${accountNumber}`,
    accountNumber,
    accountName: accountNumber,
    objectId,
    openingDebit: 0,
    openingCredit: 0,
    periodDebit: net > 0 ? net : 0,
    periodCredit: net < 0 ? -net : 0,
  });
  const objects = [
    { id: "cc-100", code: "100", name: "Verkstad" },
    { id: "cc-200", code: "200", name: "Montering" },
  ];

  it("has no Utan column when every result row carries an object, and the column sums equal the total", () => {
    const grouped = buildGroupedIncomeStatement(
      [balance("3001", "cc-100", -1000), balance("5010", "cc-200", 300), balance("5010", "cc-100", 200), balance("1930", null, 500)],
      objects
    );
    expect(grouped.columns.map((c) => c.code)).toEqual(["100", "200"]);
    expect(grouped.result).toBe(500);
    for (const entry of grouped.entries) {
      expect(entry.amounts!.reduce((sum, a) => sum + a, 0)).toBeCloseTo(entry.total, 2);
    }
    const last = [...grouped.entries].reverse().find((e) => e.kind === "subtotal")!;
    expect(last.amounts).toEqual([800, -300]);
  });

  it("gives no column to an object that only moves on balance-sheet accounts, and Utan only for result rows without one", () => {
    const grouped = buildGroupedIncomeStatement([balance("3001", "cc-100", -1000), balance("1930", "cc-200", 1000), balance("6110", null, 50)], objects);
    expect(grouped.columns).toEqual([
      { id: "cc-100", code: "100", name: "Verkstad" },
      { id: null, code: null, name: "Utan" },
    ]);
    const last = [...grouped.entries].reverse().find((e) => e.kind === "subtotal")!;
    expect(last.amounts).toEqual([1000, -50]);
    expect(last.total).toBe(950);
    // Only a bank row: no columns at all, nothing on the statement.
    expect(buildGroupedIncomeStatement([balance("1930", "cc-200", 1000)], objects).columns).toEqual([]);
  });
});

describe("huvudboken och verifikationslistan", () => {
  it("keeps only the rows carrying the object in the general ledger, with the object on the row", async () => {
    const { workshop } = await setup();
    const ledger = await reports.getGeneralLedger({ ...RANGE, onlyWithMovement: true, costCenterId: workshop.id });
    expect(ledger.accounts.map((a) => a.accountNumber)).toEqual(["3001", "5010"]);
    expect(ledger.totalDebit).toBe(200);
    expect(ledger.totalCredit).toBe(1000);
    const rent = ledger.accounts.find((a) => a.accountNumber === "5010")!;
    expect(rent.rows).toHaveLength(1);
    expect(rent.rows[0]!.costCenter).toEqual({ id: workshop.id, code: "100", name: "Verkstad" });
    expect(rent.closingBalance).toBe(200);
    const csv = await reports.getGeneralLedgerCsv({ ...RANGE, onlyWithMovement: true, costCenterId: workshop.id });
    expect(csv.content.split("\n")[0]).toContain("Kostnadsställe;Projekt");
    expect(csv.content).toContain("100 Verkstad;P1 Storköket");
  });

  it("filters the single-account ledger's rows and opening balance on the object", async () => {
    const { workshop, account } = await setup();
    const accountId = await account("5010");
    const all = await economy.getLedger({ accountId, from: `${YEAR}-01-01`, to: `${YEAR}-12-31` });
    expect(all.closingBalance).toBe(500);
    const filtered = await economy.getLedger({ accountId, from: `${YEAR}-03-01`, to: `${YEAR}-12-31`, costCenterId: workshop.id });
    expect(filtered.openingBalance).toBe(0);
    expect(filtered.rows.map((r) => [Number(r.debit), r.costCenter?.code])).toEqual([[200, "100"]]);
    expect(filtered.closingBalance).toBe(200);
  });

  it("lists the verifications with at least one row on the project, every row included and labelled", async () => {
    const { project, v1, v3 } = await setup();
    const list = await reports.getVerificationList({ projectId: project.id });
    expect(list.verifications.map((v) => v.id).sort()).toEqual([v1.id, v3.id].sort());
    const first = list.verifications.find((v) => v.id === v1.id)!;
    expect(first.rows).toHaveLength(2);
    expect(first.rows.find((r) => r.accountNumber === "3001")!.project).toEqual({ id: project.id, code: "P1", name: "Storköket" });
    expect(first.rows.find((r) => r.accountNumber === "1930")!.project).toBeNull();
    const csv = await reports.getVerificationListCsv({ projectId: project.id });
    expect(csv.content.split("\n")[0]).toContain("Kostnadsställe;Projekt");
  });
});

describe("projektrapporten", () => {
  it("sums the project's booked rows into revenue, costs and result per month and account, derives the range and lists the orders", async () => {
    const { project } = await setup();
    const [customer] = await db.insert(customers).values({ customerNumber: "K-1", name: "Storkök AB" }).returning();
    const article = await articleService.createArticle({ articleNumber: `ART-${crypto.randomUUID()}`, name: "Diskbänk", type: "manufactured", active: true });
    const [order] = await db.insert(salesOrders).values({ orderNumber: "KO-100", customerId: customer!.id, status: "confirmed", projectId: project.id }).returning();
    await db.insert(salesOrderRows).values({ salesOrderId: order!.id, articleId: article.id, quantityOrdered: "2", unitPrice: "500", discountPercent: "10" });
    // Quotes (open, lost, cancelled as a quote) and cancelled orders are not
    // the project's business — only orders are listed.
    for (const [orderNumber, status, quoteNumber] of [
      ["OF-1", "quote", "OF-1"],
      ["OF-2", "lost", "OF-2"],
      ["OF-3", "cancelled", "OF-3"],
      ["KO-101", "cancelled", null],
    ] as const) {
      const [row] = await db.insert(salesOrders).values({ orderNumber, quoteNumber, customerId: customer!.id, status, projectId: project.id }).returning();
      await db.insert(salesOrderRows).values({ salesOrderId: row!.id, articleId: article.id, quantityOrdered: "1", unitPrice: "100" });
    }

    const report = await projectReport.get({ projectId: project.id });
    expect(report.project).toEqual({ id: project.id, code: "P1", name: "Storköket", status: "open", customerName: null });
    expect(report.from).toBe(`${YEAR}-02-10`);
    expect(report.to).toBe(`${YEAR}-03-05`);
    expect(report.revenue).toBe(1000);
    expect(report.costs).toBe(200);
    expect(report.result).toBe(800);
    expect(report.months).toEqual([
      { month: `${YEAR}-02`, revenue: 1000, costs: 0, result: 1000 },
      { month: `${YEAR}-03`, revenue: 0, costs: 200, result: -200 },
    ]);
    expect(report.accounts).toEqual([
      { accountNumber: "3001", accountName: "Försäljning inom Sverige 25 %", amount: 1000 },
      { accountNumber: "5010", accountName: "Lokalhyra", amount: -200 },
    ]);
    expect(report.salesOrders).toEqual([{ id: order!.id, orderNumber: "KO-100", status: "confirmed", value: 900 }]);

    const partial = await projectReport.get({ projectId: project.id, from: `${YEAR}-03-01`, to: `${YEAR}-03-31` });
    expect(partial.from).toBe(`${YEAR}-03-01`);
    expect(partial.revenue).toBe(0);
    expect(partial.result).toBe(-200);
    await expect(projectReport.get({ projectId: crypto.randomUUID() })).rejects.toBeInstanceOf(ProjectNotFoundError);

    const csv = await projectReport.getCsv({ projectId: project.id });
    expect(csv.filename).toBe(`projektrapport-P1-${YEAR}-02-10--${YEAR}-03-05.csv`);
    expect(csv.content).toContain("Kundorder;KO-100");
  });

  it("the pure builder ignores balance accounts and keeps revenue/costs positive", () => {
    const totals = buildProjectReport([
      { date: "2027-01-05", accountNumber: "1510", accountName: "Kundfordringar", debit: 1250, credit: 0 },
      { date: "2027-01-05", accountNumber: "3001", accountName: "Försäljning", debit: 0, credit: 1000 },
      { date: "2027-01-20", accountNumber: "4010", accountName: "Material", debit: 400, credit: 0 },
      { date: "2027-02-01", accountNumber: "4010", accountName: "Material", debit: 0, credit: 100 },
    ]);
    expect(totals).toEqual({
      revenue: 1000,
      costs: 300,
      result: 700,
      months: [
        { month: "2027-01", revenue: 1000, costs: 400, result: 600 },
        { month: "2027-02", revenue: 0, costs: -100, result: 100 },
      ],
      accounts: [
        { accountNumber: "3001", accountName: "Försäljning", amount: 1000 },
        { accountNumber: "4010", accountName: "Material", amount: -300 },
      ],
    });
  });
});

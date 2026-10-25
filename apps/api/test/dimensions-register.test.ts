import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { eq, sql } from "drizzle-orm";
import {
  articleGroups,
  bankRules,
  customers,
  db,
  invoiceRows,
  invoices,
  purchaseOrders,
  salesOrders,
  supplierInvoiceRows,
  supplierInvoices,
  suppliers,
  verificationRows,
  verificationTemplateRows,
  verificationTemplates,
} from "@navet/db";
import { createAuthRepository } from "../src/modules/auth/repository/auth.repository.js";
import { createDimensionRepository } from "../src/modules/economy/repository/dimension.repository.js";
import {
  CostCenterCodeTakenError,
  CostCenterNotFoundError,
  DimensionBookedError,
  InvalidReplacementError,
  ProjectCodeTakenError,
  ProjectCustomerNotFoundError,
  ProjectDatesError,
  ProjectNotFoundError,
  RegisterEntryInUseError,
  createDimensionService,
} from "../src/modules/economy/service/dimension.service.js";
import { CostCenterInactiveError, ProjectClosedError, resolveDimensions } from "../src/modules/economy/service/dimension-check.js";
import { testEconomyService } from "./helpers/services.js";
import { vatCodeId } from "./helpers/vat-codes.js";

// Kostnadsställen och projekt (etapp 5 del A) — the two registers against
// Postgres: list/CRUD, the unique code, usage and delete with reassignment
// (the register pattern) and the one rule it adds: an object on booked
// verification rows can never be deleted, only deactivated. Plus the
// dimension rule on rows: a new choice must be active/open, a kept one may stay.

const repo = createDimensionRepository(db);
const service = createDimensionService(repo, { log: async () => {} });
const authRepo = createAuthRepository(db);

const TRUNCATE = sql`TRUNCATE bank_rules, invoice_rows, invoices, sales_orders, purchase_orders, supplier_invoice_rows, supplier_invoices, verification_template_rows, verification_templates, verification_rows, verifications, verification_counters, verification_series, accounting_periods, fiscal_years, accounts, article_groups, suppliers, customers, cost_centers, projects, audit_log, users CASCADE`;

beforeEach(async () => {
  await db.execute(TRUNCATE);
});
afterAll(async () => {
  await db.execute(TRUNCATE);
});

const YEAR = new Date().getFullYear();
const DATE = `${YEAR}-03-15`;

async function user() {
  return authRepo.create({ email: `dim-${crypto.randomUUID()}@example.com`, passwordHash: "x", name: "Ekonom", role: "admin" });
}

async function setupEconomy() {
  const u = await user();
  await testEconomyService.createFiscalYear({ label: String(YEAR), startDate: `${YEAR}-01-01`, endDate: `${YEAR}-12-31` });
  const series = await testEconomyService.createSeries({ code: "A", name: "Manuella verifikat" });
  const bank = await testEconomyService.createAccount({ number: "1930", name: "Företagskonto" });
  const rent = await testEconomyService.createAccount({ number: "5010", name: "Lokalhyra" });
  return { user: u, series, bank, rent };
}

describe("cost centers — register", () => {
  it("creates, lists with { rows, total }, filters inactive by default and searches code and name", async () => {
    const u = await user();
    const workshop = await service.costCenters.create({ code: "100", name: "Verkstad", active: true }, u.id);
    await service.costCenters.create({ code: "200", name: "Montering", active: true }, u.id);
    const office = await service.costCenters.create({ code: "300", name: "Kontor", active: true }, u.id);
    await service.costCenters.update(office.id, { active: false }, u.id);

    expect(workshop).toEqual({ id: expect.any(String), code: "100", name: "Verkstad", active: true });
    const active = await service.costCenters.list({ limit: 50, offset: 0, includeInactive: false });
    expect(active.total).toBe(2);
    expect(active.rows.map((r) => r.code)).toEqual(["100", "200"]);
    const all = await service.costCenters.list({ limit: 50, offset: 0, includeInactive: true });
    expect(all.total).toBe(3);
    const searched = await service.costCenters.list({ limit: 50, offset: 0, includeInactive: true, search: "mont" });
    expect(searched.rows.map((r) => r.code)).toEqual(["200"]);
    const paged = await service.costCenters.list({ limit: 1, offset: 1, includeInactive: true });
    expect(paged.rows.map((r) => r.code)).toEqual(["200"]);
    expect(paged.total).toBe(3);
  });

  it("refuses a taken code on create and on a PATCH onto another entry's code, but lets an entry keep its own", async () => {
    const u = await user();
    const a = await service.costCenters.create({ code: "100", name: "Verkstad", active: true }, u.id);
    await service.costCenters.create({ code: "200", name: "Montering", active: true }, u.id);
    await expect(service.costCenters.create({ code: "100", name: "Igen", active: true }, u.id)).rejects.toBeInstanceOf(CostCenterCodeTakenError);
    await expect(service.costCenters.update(a.id, { code: "200" }, u.id)).rejects.toBeInstanceOf(CostCenterCodeTakenError);
    expect((await service.costCenters.update(a.id, { code: "100", name: "Verkstaden" }, u.id)).name).toBe("Verkstaden");
    await expect(service.costCenters.get(crypto.randomUUID())).rejects.toBeInstanceOf(CostCenterNotFoundError);
  });

  it("reports usage per referencing table and moves every reference to the replacement before deleting", async () => {
    const { user: u, series, bank, rent } = await setupEconomy();
    const old = await service.costCenters.create({ code: "100", name: "Verkstad", active: true }, u.id);
    const next = await service.costCenters.create({ code: "110", name: "Verkstad 2", active: true }, u.id);

    // A draft verification row, a template row, an invoice row, an order
    // header, a bank rule, an article group default and a supplier default.
    const draft = await testEconomyService.createVerification(
      { seriesId: series.id, date: DATE, description: "Hyra", rows: [{ accountId: rent.id, debit: 100, credit: 0, costCenterId: old.id }, { accountId: bank.id, debit: 0, credit: 100 }], book: false },
      u.id
    );
    const [template] = await db.insert(verificationTemplates).values({ name: "Hyra", seriesId: series.id, description: "Hyra" }).returning();
    await db.insert(verificationTemplateRows).values({ templateId: template!.id, accountNumber: "5010", debit: "100", costCenterId: old.id, sortOrder: 0 });
    const [customer] = await db.insert(customers).values({ customerNumber: "K-1", name: "Kund AB" }).returning();
    const [order] = await db.insert(salesOrders).values({ orderNumber: "KO-1", customerId: customer!.id, costCenterId: old.id }).returning();
    const [invoice] = await db.insert(invoices).values({ customerId: customer!.id, currency: "SEK", exchangeRate: "1" }).returning();
    await db.insert(invoiceRows).values({
      invoiceId: invoice!.id,
      description: "Rad",
      quantity: "1",
      unitPrice: "10",
      lineAmount: "10",
      vatAmount: "0",
      vatRate: "0",
      vatCodeId: await vatCodeId("MP25"),
      costCenterId: old.id,
    });
    await db.insert(bankRules).values({ textContains: "hyra", direction: "out", accountNumber: "5010", costCenterId: old.id });
    await db.insert(articleGroups).values({ code: "100", name: "Grupp", defaultCostCenterId: old.id });
    await db.insert(suppliers).values({ supplierNumber: "L-1", name: "Lev AB", defaultCostCenterId: old.id });

    const usage = await service.costCenters.usage(old.id);
    expect(usage.total).toBe(7);
    expect(usage.references.map((r) => r.table).sort()).toEqual(
      ["article_groups", "bank_rules", "invoice_rows", "sales_orders", "suppliers", "verification_rows", "verification_template_rows"].sort()
    );
    expect(usage.references.find((r) => r.table === "verification_rows")).toMatchObject({ label: "verifikatrader (utkast)", count: 1 });

    await expect(service.costCenters.remove(old.id, null, u.id)).rejects.toBeInstanceOf(RegisterEntryInUseError);
    await expect(service.costCenters.remove(old.id, old.id, u.id)).rejects.toBeInstanceOf(InvalidReplacementError);
    await expect(service.costCenters.remove(old.id, crypto.randomUUID(), u.id)).rejects.toBeInstanceOf(InvalidReplacementError);

    const result = await service.costCenters.remove(old.id, next.id, u.id);
    expect(result.moved.reduce((sum, m) => sum + m.count, 0)).toBe(7);
    expect(await repo.costCenters.findById(old.id)).toBeNull();
    const [row] = await db.select().from(verificationRows).where(eq(verificationRows.verificationId, draft.id)).orderBy(verificationRows.createdAt);
    expect(row!.costCenterId).toBe(next.id);
    expect((await db.select().from(salesOrders).where(eq(salesOrders.id, order!.id)))[0]!.costCenterId).toBe(next.id);
    expect((await db.select().from(suppliers))[0]!.defaultCostCenterId).toBe(next.id);
    expect((await db.select().from(articleGroups))[0]!.defaultCostCenterId).toBe(next.id);
  });

  it("never deletes a cost center carried by a booked verification row — replacement or not", async () => {
    const { user: u, series, bank, rent } = await setupEconomy();
    const old = await service.costCenters.create({ code: "100", name: "Verkstad", active: true }, u.id);
    const next = await service.costCenters.create({ code: "110", name: "Verkstad 2", active: true }, u.id);
    await testEconomyService.createVerification(
      { seriesId: series.id, date: DATE, description: "Hyra", rows: [{ accountId: rent.id, debit: 100, credit: 0, costCenterId: old.id }, { accountId: bank.id, debit: 0, credit: 100 }], book: true },
      u.id
    );
    const usage = await service.costCenters.usage(old.id);
    expect(usage.references).toEqual([{ table: "verification_rows", label: "bokförda verifikatrader", labelOne: "bokförd verifikatrad", count: 1, blocksReplacement: true }]);
    await expect(service.costCenters.remove(old.id, next.id, u.id)).rejects.toBeInstanceOf(DimensionBookedError);
    await expect(service.costCenters.remove(old.id, null, u.id)).rejects.toBeInstanceOf(DimensionBookedError);
    // Deactivating is the way out.
    expect((await service.costCenters.update(old.id, { active: false }, u.id)).active).toBe(false);
  });
});

describe("locked documents", () => {
  it("moves the objects on drafts and open orders only; a locked document blocks the delete like a booked row, flagged in the usage", async () => {
    const { user: u } = await setupEconomy();
    const old = await service.costCenters.create({ code: "100", name: "Verkstad", active: true }, u.id);
    const next = await service.costCenters.create({ code: "110", name: "Verkstad 2", active: true }, u.id);
    const [customer] = await db.insert(customers).values({ customerNumber: "K-1", name: "Kund AB" }).returning();
    const row = async (invoiceId: string, costCenterId: string) =>
      db.insert(invoiceRows).values({
        invoiceId,
        description: "Rad",
        quantity: "1",
        unitPrice: "10",
        lineAmount: "10",
        vatAmount: "0",
        vatRate: "0",
        vatCodeId: await vatCodeId("MP25"),
        costCenterId,
      });
    const [draftInvoice] = await db.insert(invoices).values({ customerId: customer!.id, currency: "SEK", exchangeRate: "1" }).returning();
    await row(draftInvoice!.id, old.id);
    const [openOrder] = await db.insert(salesOrders).values({ orderNumber: "KO-1", customerId: customer!.id, status: "confirmed", costCenterId: old.id }).returning();

    // Drafts and open orders only: the move goes through.
    const movable = await service.costCenters.usage(old.id);
    expect(movable.references.map((r) => [r.table, r.labelOne, r.blocksReplacement])).toEqual([
      ["invoice_rows", "kundfakturarad (utkast)", false],
      ["sales_orders", "kundorder", false],
    ]);
    await service.costCenters.remove(old.id, next.id, u.id);
    expect((await db.select().from(salesOrders).where(eq(salesOrders.id, openOrder!.id)))[0]!.costCenterId).toBe(next.id);

    // An issued invoice's row and a delivered order are locked: the usage
    // says so and the delete is refused with or without a replacement —
    // the draft row is NOT moved either (all or nothing).
    const third = await service.costCenters.create({ code: "120", name: "Verkstad 3", active: true }, u.id);
    const [issued] = await db
      .insert(invoices)
      .values({ customerId: customer!.id, currency: "SEK", exchangeRate: "1", status: "issued", invoiceNumber: "FA-1", invoiceDate: DATE, dueDate: DATE })
      .returning();
    await row(issued!.id, next.id);
    await db.insert(salesOrders).values({ orderNumber: "KO-2", customerId: customer!.id, status: "delivered", costCenterId: next.id });
    const locked = await service.costCenters.usage(next.id);
    expect(locked.references.map((r) => [r.table, r.labelOne, r.blocksReplacement])).toEqual([
      ["invoice_rows", "kundfakturarad (utkast)", false],
      ["invoice_rows", "kundfakturarad (utfärdad)", true],
      ["sales_orders", "kundorder", false],
      ["sales_orders", "avslutad kundorder", true],
    ]);
    await expect(service.costCenters.remove(next.id, third.id, u.id)).rejects.toBeInstanceOf(DimensionBookedError);
    await expect(service.costCenters.remove(next.id, null, u.id)).rejects.toBeInstanceOf(DimensionBookedError);
    expect((await db.select().from(invoiceRows).where(eq(invoiceRows.invoiceId, draftInvoice!.id)))[0]!.costCenterId).toBe(next.id);
    expect(await repo.costCenters.findById(next.id)).not.toBeNull();
  });

  it("a project on an attested supplier invoice or a closed purchase order is locked too", async () => {
    const { user: u } = await setupEconomy();
    const old = await service.projects.create({ code: "P1", name: "Ett", active: true, status: "open" }, u.id);
    const next = await service.projects.create({ code: "P2", name: "Två", active: true, status: "open" }, u.id);
    const [supplier] = await db.insert(suppliers).values({ supplierNumber: "L-1", name: "Lev AB" }).returning();
    const [draft] = await db
      .insert(supplierInvoices)
      .values({
        registrationNumber: "LF-1",
        supplierId: supplier!.id,
        invoiceNumber: "F-1",
        invoiceDate: DATE,
        dueDate: DATE,
        netAmount: "100",
        vatAmount: "25",
        grossAmount: "125",
        vatCodeId: await vatCodeId("MP25"),
        projectId: old.id,
      })
      .returning();
    await db.insert(supplierInvoiceRows).values({ supplierInvoiceId: draft!.id, description: "Rad", quantity: "1", unitPrice: "100", lineAmount: "100", projectId: old.id });
    await db.insert(purchaseOrders).values({ orderNumber: "IO-1", supplierId: supplier!.id, status: "confirmed", projectId: old.id });
    expect((await service.projects.usage(old.id)).references.map((r) => [r.labelOne, r.blocksReplacement])).toEqual([
      ["leverantörsfaktura (utkast)", false],
      ["leverantörsfakturarad (utkast)", false],
      ["inköpsorder", false],
    ]);
    await service.projects.remove(old.id, next.id, u.id);
    expect((await db.select().from(supplierInvoiceRows))[0]!.projectId).toBe(next.id);

    await db.update(supplierInvoices).set({ status: "approved" });
    await db.update(purchaseOrders).set({ status: "received" });
    const third = await service.projects.create({ code: "P3", name: "Tre", active: true, status: "open" }, u.id);
    expect((await service.projects.usage(next.id)).references.map((r) => [r.labelOne, r.blocksReplacement])).toEqual([
      ["leverantörsfaktura (attesterad)", true],
      ["leverantörsfakturarad (attesterad)", true],
      ["avslutad inköpsorder", true],
    ]);
    await expect(service.projects.remove(next.id, third.id, u.id)).rejects.toBeInstanceOf(DimensionBookedError);
  });
});

describe("projects — register", () => {
  it("creates with customer, status and dates, lists by status and joins the customer's name", async () => {
    const u = await user();
    const [customer] = await db.insert(customers).values({ customerNumber: "K-1", name: "Storkök AB" }).returning();
    const open = await service.projects.create(
      { code: "P1", name: "Storköket", active: true, status: "open", customerId: customer!.id, startDate: `${YEAR}-01-10`, endDate: null },
      u.id
    );
    const closed = await service.projects.create({ code: "P2", name: "Gammalt", active: true, status: "closed", customerId: null }, u.id);
    expect(open).toEqual({
      id: expect.any(String),
      code: "P1",
      name: "Storköket",
      active: true,
      status: "open",
      customerId: customer!.id,
      customerName: "Storkök AB",
      startDate: `${YEAR}-01-10`,
      endDate: null,
    });
    expect((await service.projects.list({ limit: 50, offset: 0, includeInactive: false, status: "open" })).rows.map((p) => p.code)).toEqual(["P1"]);
    expect((await service.projects.list({ limit: 50, offset: 0, includeInactive: false, status: "closed" })).rows.map((p) => p.code)).toEqual(["P2"]);
    expect((await service.projects.list({ limit: 50, offset: 0, includeInactive: false, search: "storkök" })).rows.map((p) => p.code)).toEqual(["P1"]);
    await expect(service.projects.create({ code: "P1", name: "Igen", active: true, status: "open" }, u.id)).rejects.toBeInstanceOf(ProjectCodeTakenError);
    await expect(service.projects.create({ code: "P3", name: "X", active: true, status: "open", customerId: crypto.randomUUID() }, u.id)).rejects.toBeInstanceOf(
      ProjectCustomerNotFoundError
    );
    await expect(service.projects.update(open.id, { endDate: `${YEAR}-01-01` }, u.id)).rejects.toBeInstanceOf(ProjectDatesError);
    expect((await service.projects.update(closed.id, { status: "open" }, u.id)).status).toBe("open");
    await expect(service.projects.usage(crypto.randomUUID())).rejects.toBeInstanceOf(ProjectNotFoundError);
  });

  it("deletes with reassignment like the cost centers and refuses when booked rows carry it", async () => {
    const { user: u, series, bank, rent } = await setupEconomy();
    const old = await service.projects.create({ code: "P1", name: "Ett", active: true, status: "open" }, u.id);
    const next = await service.projects.create({ code: "P2", name: "Två", active: true, status: "open" }, u.id);
    const draft = await testEconomyService.createVerification(
      { seriesId: series.id, date: DATE, description: "Hyra", rows: [{ accountId: rent.id, debit: 100, credit: 0, projectId: old.id }, { accountId: bank.id, debit: 0, credit: 100 }], book: false },
      u.id
    );
    expect((await service.projects.usage(old.id)).total).toBe(1);
    await service.projects.remove(old.id, next.id, u.id);
    const [row] = await db.select().from(verificationRows).where(eq(verificationRows.verificationId, draft.id)).orderBy(verificationRows.createdAt);
    expect(row!.projectId).toBe(next.id);

    await testEconomyService.book(draft.id, u.id);
    await expect(service.projects.remove(next.id, null, u.id)).rejects.toBeInstanceOf(DimensionBookedError);
  });
});

describe("the dimension rule on rows", () => {
  it("refuses an inactive cost center and a closed project on a NEW row, keeps them on a kept row, drops a stale default silently", async () => {
    const u = await user();
    const inactive = await service.costCenters.create({ code: "900", name: "Nedlagt", active: false }, u.id);
    const closed = await service.projects.create({ code: "P9", name: "Klart", active: true, status: "closed" }, u.id);
    const open = await service.projects.create({ code: "P1", name: "Pågår", active: true, status: "open" }, u.id);

    await expect(resolveDimensions(db, { costCenterId: inactive.id })).rejects.toBeInstanceOf(CostCenterInactiveError);
    await expect(resolveDimensions(db, { projectId: closed.id })).rejects.toBeInstanceOf(ProjectClosedError);
    await expect(resolveDimensions(db, { projectId: crypto.randomUUID() })).rejects.toBeInstanceOf(ProjectNotFoundError);
    await expect(resolveDimensions(db, { costCenterId: crypto.randomUUID() })).rejects.toBeInstanceOf(CostCenterNotFoundError);
    // Sending the row's own (now closed) object again is not a new choice.
    expect(await resolveDimensions(db, { projectId: closed.id }, { existing: { costCenterId: null, projectId: closed.id } })).toEqual({ costCenterId: null, projectId: closed.id });
    // An omitted field keeps the row's value on a PATCH …
    expect(await resolveDimensions(db, {}, { existing: { costCenterId: inactive.id, projectId: null } })).toEqual({ costCenterId: inactive.id, projectId: null });
    // … or, for a full-row write, means none.
    expect(await resolveDimensions(db, {}, { existing: { costCenterId: inactive.id, projectId: null }, omittedKeepsExisting: false })).toEqual({ costCenterId: null, projectId: null });
    // A default that no longer passes is dropped, never refused; a good one is taken.
    expect(await resolveDimensions(db, {}, { fallback: { costCenterId: inactive.id, projectId: closed.id } })).toEqual({ costCenterId: null, projectId: null });
    expect(await resolveDimensions(db, {}, { fallback: { projectId: open.id } })).toEqual({ costCenterId: null, projectId: open.id });
    // null in the input is an explicit "none" that beats the default.
    expect(await resolveDimensions(db, { projectId: null }, { fallback: { projectId: open.id } })).toEqual({ costCenterId: null, projectId: null });
  });

  it("Kopiera treats the source rows' objects as a new choice: a project closed since refuses the copy", async () => {
    const { user: u, series, bank, rent } = await setupEconomy();
    const project = await service.projects.create({ code: "P1", name: "Pågår", active: true, status: "open" }, u.id);
    const booked = await testEconomyService.createVerification(
      { seriesId: series.id, date: DATE, description: "Hyra", rows: [{ accountId: rent.id, debit: 100, credit: 0, projectId: project.id }, { accountId: bank.id, debit: 0, credit: 100 }], book: true },
      u.id
    );
    const copy = await testEconomyService.copy(booked.id, u.id);
    expect(copy.verification.rows[0]!.project?.id).toBe(project.id);
    await service.projects.update(project.id, { status: "closed" }, u.id);
    await expect(testEconomyService.copy(booked.id, u.id)).rejects.toBeInstanceOf(ProjectClosedError);
    // The source itself keeps the closed project, untouched.
    expect((await testEconomyService.findVerificationById(booked.id)).rows[0]!.project?.id).toBe(project.id);
  });

  it("holds a manual verification row to the rule and returns the objects as { id, code, name }", async () => {
    const { user: u, series, bank, rent } = await setupEconomy();
    const workshop = await service.costCenters.create({ code: "100", name: "Verkstad", active: true }, u.id);
    const closed = await service.projects.create({ code: "P9", name: "Klart", active: true, status: "closed" }, u.id);
    await expect(
      testEconomyService.createVerification(
        { seriesId: series.id, date: DATE, description: "Hyra", rows: [{ accountId: rent.id, debit: 100, credit: 0, projectId: closed.id }, { accountId: bank.id, debit: 0, credit: 100 }], book: false },
        u.id
      )
    ).rejects.toBeInstanceOf(ProjectClosedError);
    const draft = await testEconomyService.createVerification(
      { seriesId: series.id, date: DATE, description: "Hyra", rows: [{ accountId: rent.id, debit: 100, credit: 0, costCenterId: workshop.id }, { accountId: bank.id, debit: 0, credit: 100 }], book: false },
      u.id
    );
    expect(draft.rows[0]!.costCenter).toEqual({ id: workshop.id, code: "100", name: "Verkstad" });
    expect(draft.rows[0]!.project).toBeNull();
    expect(draft.rows[1]!.costCenter).toBeNull();
    expect(draft.warnings).toEqual([]);
  });
});

import { and, asc, count, eq, ilike, or, sql, type SQL } from "drizzle-orm";
import type { PgColumn, PgTable } from "drizzle-orm/pg-core";
import {
  articleGroups,
  bankRules,
  costCenters,
  customers,
  fixedAssetCategories,
  invoiceRows,
  projects,
  purchaseOrders,
  salesOrders,
  supplierInvoiceRows,
  supplierInvoices,
  suppliers,
  verificationRows,
  verificationTemplateRows,
  verifications,
  type Db,
} from "@navet/db";
import type { ListCostCentersQuery, ListProjectsQuery, ProjectStatus } from "@navet/shared";
import { ilikePattern } from "@navet/shared";
import { isForeignKeyViolation } from "../../system/service/db-errors.js";
import { RegisterEntryInUseError, type RegisterUsage } from "../../register/service/register.errors.js";

// Kostnadsställen och projekt (etapp 5 del A): the two registers with the
// base-data register behaviour — usage summary and delete-with-reassignment
// (the register module's pattern, see register.repository.ts). What differs
// from the terms registers: a dimension on a BOOKED verification row can
// never be moved (the 0095 triggers refuse every UPDATE of a locked row and
// the bookkeeping must not be rewritten), so an object carried by booked rows
// cannot be deleted at all — only deactivated (DimensionBookedError). Draft
// rows, templates, documents and defaults move like any register reference.
//
// EVERY new FK to cost_centers/projects must be added to the two lists below
// (the FK's onDelete: "restrict" still guards the database; a missing entry
// here just turns the friendly flow into a 409 at the final DELETE).

interface DimensionReference {
  table: PgTable;
  tableName: string;
  label: string;
  labelOne: string;
  column: PgColumn;
  // Verification rows are split into the draft rows (movable) and the
  // booked ones (immutable); every other reference has no extra condition.
  rows?: "draft" | "booked";
}

function ref(table: PgTable, tableName: string, labels: string, column: PgColumn, rows?: "draft" | "booked"): DimensionReference {
  const [labelOne, label] = labels.split("|") as [string, string];
  return rows ? { table, tableName, label, labelOne, column, rows } : { table, tableName, label, labelOne, column };
}

const bookedRowCondition = (column: PgColumn, id: string, status: "draft" | "booked") =>
  and(
    eq(column, id),
    sql`${verificationRows.verificationId} in (select ${verifications.id} from ${verifications} where ${verifications.status} = ${status})`
  );

const COST_CENTER_REFERENCES: DimensionReference[] = [
  ref(verificationRows, "verification_rows", "bokförd verifikatrad|bokförda verifikatrader", verificationRows.costCenterId, "booked"),
  ref(verificationRows, "verification_rows", "verifikatrad (utkast)|verifikatrader (utkast)", verificationRows.costCenterId, "draft"),
  ref(verificationTemplateRows, "verification_template_rows", "mallrad|mallrader", verificationTemplateRows.costCenterId),
  ref(invoiceRows, "invoice_rows", "kundfakturarad|kundfakturarader", invoiceRows.costCenterId),
  ref(supplierInvoices, "supplier_invoices", "leverantörsfaktura|leverantörsfakturor", supplierInvoices.costCenterId),
  ref(supplierInvoiceRows, "supplier_invoice_rows", "leverantörsfakturarad|leverantörsfakturarader", supplierInvoiceRows.costCenterId),
  ref(salesOrders, "sales_orders", "kundorder|kundorder", salesOrders.costCenterId),
  ref(bankRules, "bank_rules", "bankregel|bankregler", bankRules.costCenterId),
  ref(articleGroups, "article_groups", "artikelgrupp (förval)|artikelgrupper (förval)", articleGroups.defaultCostCenterId),
  ref(suppliers, "suppliers", "leverantör (förval)|leverantörer (förval)", suppliers.defaultCostCenterId),
  ref(fixedAssetCategories, "fixed_asset_categories", "tillgångsgrupp (förval)|tillgångsgrupper (förval)", fixedAssetCategories.defaultCostCenterId),
];

const PROJECT_REFERENCES: DimensionReference[] = [
  ref(verificationRows, "verification_rows", "bokförd verifikatrad|bokförda verifikatrader", verificationRows.projectId, "booked"),
  ref(verificationRows, "verification_rows", "verifikatrad (utkast)|verifikatrader (utkast)", verificationRows.projectId, "draft"),
  ref(verificationTemplateRows, "verification_template_rows", "mallrad|mallrader", verificationTemplateRows.projectId),
  ref(invoiceRows, "invoice_rows", "kundfakturarad|kundfakturarader", invoiceRows.projectId),
  ref(supplierInvoices, "supplier_invoices", "leverantörsfaktura|leverantörsfakturor", supplierInvoices.projectId),
  ref(supplierInvoiceRows, "supplier_invoice_rows", "leverantörsfakturarad|leverantörsfakturarader", supplierInvoiceRows.projectId),
  ref(salesOrders, "sales_orders", "kundorder|kundorder", salesOrders.projectId),
  ref(purchaseOrders, "purchase_orders", "inköpsorder|inköpsorder", purchaseOrders.projectId),
  ref(bankRules, "bank_rules", "bankregel|bankregler", bankRules.projectId),
];

export type CostCenterRow = typeof costCenters.$inferSelect;
export type ProjectRow = typeof projects.$inferSelect & { customerName: string | null };

export type CostCenterWrite = { code: string; name: string; active: boolean };
export type ProjectWrite = {
  code: string;
  name: string;
  active: boolean;
  status: ProjectStatus;
  customerId: string | null;
  startDate: string | null;
  endDate: string | null;
};

export function createDimensionRepository(db: Db) {
  function whereFor(r: DimensionReference, id: string): SQL {
    return r.rows ? bookedRowCondition(r.column, id, r.rows)! : eq(r.column, id);
  }

  async function countReferences(references: DimensionReference[], id: string): Promise<RegisterUsage> {
    const found: RegisterUsage["references"] = [];
    for (const r of references) {
      const [row] = await db.select({ n: count() }).from(r.table).where(whereFor(r, id));
      const n = Number(row?.n ?? 0);
      if (n > 0) found.push({ table: r.tableName, label: r.label, labelOne: r.labelOne, count: n });
    }
    return { total: found.reduce((sum, r) => sum + r.count, 0), references: found };
  }

  async function bookedRowCount(column: PgColumn, id: string): Promise<number> {
    const [row] = await db.select({ n: count() }).from(verificationRows).where(bookedRowCondition(column, id, "booked"));
    return Number(row?.n ?? 0);
  }

  // Moves every movable reference to `replacementId` (when given) and
  // deletes the entry in one transaction. Booked verification rows are
  // never touched: the service refuses an object they carry up front
  // (hasBookedRows → DimensionBookedError) — and the FK on the final DELETE
  // is the race guard for a row booked in between (RegisterEntryInUseError).
  async function deleteWithReassign(
    table: typeof costCenters | typeof projects,
    references: DimensionReference[],
    entry: { id: string; code: string },
    replacementId: string | null
  ) {
    try {
      return await db.transaction(async (tx) => {
        const moved: { table: string; count: number }[] = [];
        if (replacementId) {
          for (const r of references) {
            if (r.rows === "booked") continue;
            const [before] = await tx.select({ n: count() }).from(r.table).where(whereFor(r, entry.id));
            const n = Number(before?.n ?? 0);
            if (n === 0) continue;
            await tx.execute(sql`UPDATE ${r.table} SET ${sql.identifier(r.column.name)} = ${replacementId} WHERE ${whereFor(r, entry.id)}`);
            moved.push({ table: r.tableName, count: n });
          }
        }
        await tx.delete(table).where(eq(table.id, entry.id));
        return { moved };
      });
    } catch (err) {
      if (isForeignKeyViolation(err)) throw new RegisterEntryInUseError(entry.code, await countReferences(references, entry.id));
      throw err;
    }
  }

  return {
    costCenters: {
      async list(query: ListCostCentersQuery): Promise<{ rows: CostCenterRow[]; total: number }> {
        const conditions: SQL[] = [];
        if (!query.includeInactive) conditions.push(eq(costCenters.active, true));
        if (query.search) {
          const pattern = ilikePattern(query.search);
          conditions.push(or(ilike(costCenters.code, pattern), ilike(costCenters.name, pattern))!);
        }
        const where = conditions.length > 0 ? and(...conditions) : undefined;
        const [rows, totals] = await Promise.all([
          db.select().from(costCenters).where(where).orderBy(asc(costCenters.code)).limit(query.limit).offset(query.offset),
          db.select({ total: count() }).from(costCenters).where(where),
        ]);
        return { rows, total: Number(totals[0]!.total) };
      },
      async findById(id: string): Promise<CostCenterRow | null> {
        const [row] = await db.select().from(costCenters).where(eq(costCenters.id, id));
        return row ?? null;
      },
      async findByCode(code: string): Promise<CostCenterRow | null> {
        const [row] = await db.select().from(costCenters).where(eq(costCenters.code, code));
        return row ?? null;
      },
      async create(input: CostCenterWrite): Promise<CostCenterRow> {
        const [row] = await db.insert(costCenters).values(input).returning();
        return row!;
      },
      async update(id: string, patch: Partial<CostCenterWrite>): Promise<CostCenterRow | null> {
        const [row] = await db
          .update(costCenters)
          .set({ ...patch, updatedAt: new Date() })
          .where(eq(costCenters.id, id))
          .returning();
        return row ?? null;
      },
      async countReferences(id: string) {
        return countReferences(COST_CENTER_REFERENCES, id);
      },
      async hasBookedRows(id: string) {
        return (await bookedRowCount(verificationRows.costCenterId, id)) > 0;
      },
      async deleteWithReassign(entry: { id: string; code: string }, replacementId: string | null) {
        return deleteWithReassign(costCenters, COST_CENTER_REFERENCES, entry, replacementId);
      },
    },

    projects: {
      async list(query: ListProjectsQuery): Promise<{ rows: ProjectRow[]; total: number }> {
        const conditions: SQL[] = [];
        if (!query.includeInactive) conditions.push(eq(projects.active, true));
        if (query.status) conditions.push(eq(projects.status, query.status));
        if (query.search) {
          const pattern = ilikePattern(query.search);
          conditions.push(or(ilike(projects.code, pattern), ilike(projects.name, pattern), ilike(customers.name, pattern))!);
        }
        const where = conditions.length > 0 ? and(...conditions) : undefined;
        const base = () => db.select({ ...projectColumns, customerName: customers.name }).from(projects).leftJoin(customers, eq(customers.id, projects.customerId));
        const [rows, totals] = await Promise.all([
          base().where(where).orderBy(asc(projects.code)).limit(query.limit).offset(query.offset),
          db.select({ total: count() }).from(projects).leftJoin(customers, eq(customers.id, projects.customerId)).where(where),
        ]);
        return { rows, total: Number(totals[0]!.total) };
      },
      async findById(id: string): Promise<ProjectRow | null> {
        const [row] = await db
          .select({ ...projectColumns, customerName: customers.name })
          .from(projects)
          .leftJoin(customers, eq(customers.id, projects.customerId))
          .where(eq(projects.id, id));
        return row ?? null;
      },
      async findByCode(code: string) {
        const [row] = await db.select().from(projects).where(eq(projects.code, code));
        return row ?? null;
      },
      async customerExists(id: string): Promise<boolean> {
        const [row] = await db.select({ id: customers.id }).from(customers).where(eq(customers.id, id));
        return row !== undefined;
      },
      async create(input: ProjectWrite): Promise<ProjectRow> {
        const [row] = await db.insert(projects).values(input).returning();
        return (await this.findById(row!.id))!;
      },
      async update(id: string, patch: Partial<ProjectWrite>): Promise<ProjectRow | null> {
        const [row] = await db
          .update(projects)
          .set({ ...patch, updatedAt: new Date() })
          .where(eq(projects.id, id))
          .returning();
        return row ? this.findById(row.id) : null;
      },
      async countReferences(id: string) {
        return countReferences(PROJECT_REFERENCES, id);
      },
      async hasBookedRows(id: string) {
        return (await bookedRowCount(verificationRows.projectId, id)) > 0;
      },
      async deleteWithReassign(entry: { id: string; code: string }, replacementId: string | null) {
        return deleteWithReassign(projects, PROJECT_REFERENCES, entry, replacementId);
      },
    },
  };
}

const projectColumns = {
  id: projects.id,
  code: projects.code,
  name: projects.name,
  active: projects.active,
  status: projects.status,
  customerId: projects.customerId,
  startDate: projects.startDate,
  endDate: projects.endDate,
  createdAt: projects.createdAt,
  updatedAt: projects.updatedAt,
};

export type DimensionRepository = ReturnType<typeof createDimensionRepository>;

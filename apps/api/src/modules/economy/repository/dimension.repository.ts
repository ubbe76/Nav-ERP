import { and, asc, count, eq, ilike, or, sql, type SQL } from "drizzle-orm";
import type { PgColumn, PgTable } from "drizzle-orm/pg-core";
import {
  articleGroups,
  bankRules,
  budgetLines,
  costCenters,
  customers,
  fixedAssetCategories,
  invoiceRows,
  invoices,
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
  type Tx,
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
// the bookkeeping must not be rewritten), and neither can one on a document
// that is no longer a draft (an issued customer invoice's rows, an attested
// supplier invoice, a delivered or cancelled order — their verifications
// are booked and the document is the underlag). An object such rows carry
// cannot be deleted at all — only deactivated (DimensionBookedError). Draft
// rows, open documents, templates and defaults move like any register
// reference. Each reference says so with `blocksReplacement` in the usage.
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
  // Rows the delete may not move: the usage lists them as a blocker and
  // the service refuses the delete while any exist.
  locked: boolean;
  // The rows this reference counts beyond `column = id` (the status split
  // of a locked/movable pair); none = every row.
  condition?: (id: string) => SQL;
  // A reference whose rows cannot simply be re-pointed (a unique key would
  // collide): the move is this statement instead of the generic UPDATE.
  move?: (tx: Tx, id: string, replacementId: string) => Promise<void>;
}

function ref(table: PgTable, tableName: string, labels: string, column: PgColumn): DimensionReference {
  const [labelOne, label] = labels.split("|") as [string, string];
  return { table, tableName, label, labelOne, column, locked: false };
}

// A table whose rows are movable while the document is open and locked once
// it is not: two references, `movableLabels` for the first, `lockedLabels`
// for the second, split on `lockedWhen`.
function split(
  table: PgTable,
  tableName: string,
  column: PgColumn,
  movableLabels: string,
  lockedLabels: string,
  lockedWhen: SQL
): DimensionReference[] {
  const movable = ref(table, tableName, movableLabels, column);
  const locked = ref(table, tableName, lockedLabels, column);
  return [
    { ...movable, condition: (id) => and(eq(column, id), sql`not (${lockedWhen})`)! },
    { ...locked, locked: true, condition: (id) => and(eq(column, id), lockedWhen)! },
  ];
}

// Document states where the header can no longer be edited (the status
// guards in sales.service.ts / purchase.service.ts / supplier-invoice.service.ts).
const verificationBooked = sql`${verificationRows.verificationId} in (select ${verifications.id} from ${verifications} where ${verifications.status} = 'booked')`;
const invoiceNotDraft = sql`${invoiceRows.invoiceId} in (select ${invoices.id} from ${invoices} where ${invoices.status} <> 'draft')`;
const supplierInvoiceNotDraft = sql`${supplierInvoices.status} <> 'draft'`;
const supplierInvoiceRowNotDraft = sql`${supplierInvoiceRows.supplierInvoiceId} in (select ${supplierInvoices.id} from ${supplierInvoices} where ${supplierInvoices.status} <> 'draft')`;
const salesOrderClosed = sql`${salesOrders.status} in ('delivered', 'invoiced', 'cancelled', 'lost')`;

// Budget lines are unique per (budget, account, month, cost center), so a
// line the replacement already has for the same key is SUMMED into it (a
// sum of zero removes the line — zero is never stored) before the rest are
// re-pointed. Decision 10 of the budget contract.
async function moveBudgetLines(tx: Tx, id: string, replacementId: string) {
  const paired = sql`source.cost_center_id = ${id} AND target.cost_center_id = ${replacementId}
      AND target.budget_id = source.budget_id AND target.account_number = source.account_number AND target.month = source.month`;
  // Pairs that cancel out go first — both rows — since the CHECK refuses an
  // updated amount of 0.
  await tx.execute(sql`
    DELETE FROM ${budgetLines} WHERE id IN (
      SELECT source.id FROM ${budgetLines} AS source JOIN ${budgetLines} AS target ON ${paired} WHERE target.amount + source.amount = 0
      UNION
      SELECT target.id FROM ${budgetLines} AS source JOIN ${budgetLines} AS target ON ${paired} WHERE target.amount + source.amount = 0
    )
  `);
  await tx.execute(sql`
    UPDATE ${budgetLines} AS target SET amount = target.amount + source.amount
    FROM ${budgetLines} AS source
    WHERE ${paired}
  `);
  await tx.execute(sql`
    DELETE FROM ${budgetLines} AS source
    USING ${budgetLines} AS target
    WHERE ${paired}
  `);
  await tx.execute(sql`UPDATE ${budgetLines} SET cost_center_id = ${replacementId} WHERE cost_center_id = ${id}`);
}
const purchaseOrderClosed = sql`${purchaseOrders.status} in ('received', 'closed', 'cancelled')`;

function references(dimension: "costCenter" | "project"): DimensionReference[] {
  const column = <T extends { costCenterId?: PgColumn; projectId?: PgColumn; defaultCostCenterId?: PgColumn }>(t: T): PgColumn =>
    (dimension === "costCenter" ? (t.costCenterId ?? t.defaultCostCenterId) : t.projectId) as PgColumn;
  return [
    ...split(
      verificationRows,
      "verification_rows",
      column(verificationRows),
      "verifikatrad (utkast)|verifikatrader (utkast)",
      "bokförd verifikatrad|bokförda verifikatrader",
      verificationBooked
    ),
    ref(verificationTemplateRows, "verification_template_rows", "mallrad|mallrader", column(verificationTemplateRows)),
    ...split(invoiceRows, "invoice_rows", column(invoiceRows), "kundfakturarad (utkast)|kundfakturarader (utkast)", "kundfakturarad (utfärdad)|kundfakturarader (utfärdade)", invoiceNotDraft),
    ...split(
      supplierInvoices,
      "supplier_invoices",
      column(supplierInvoices),
      "leverantörsfaktura (utkast)|leverantörsfakturor (utkast)",
      "leverantörsfaktura (attesterad)|leverantörsfakturor (attesterade)",
      supplierInvoiceNotDraft
    ),
    ...split(
      supplierInvoiceRows,
      "supplier_invoice_rows",
      column(supplierInvoiceRows),
      "leverantörsfakturarad (utkast)|leverantörsfakturarader (utkast)",
      "leverantörsfakturarad (attesterad)|leverantörsfakturarader (attesterade)",
      supplierInvoiceRowNotDraft
    ),
    ...split(salesOrders, "sales_orders", column(salesOrders), "kundorder|kundorder", "avslutad kundorder|avslutade kundorder", salesOrderClosed),
    ...(dimension === "project"
      ? split(purchaseOrders, "purchase_orders", column(purchaseOrders), "inköpsorder|inköpsorder", "avslutad inköpsorder|avslutade inköpsorder", purchaseOrderClosed)
      : []),
    ref(bankRules, "bank_rules", "bankregel|bankregler", column(bankRules)),
    ...(dimension === "costCenter"
      ? [
          ref(articleGroups, "article_groups", "varugrupp (förval)|varugrupper (förval)", articleGroups.defaultCostCenterId),
          ref(suppliers, "suppliers", "leverantör (förval)|leverantörer (förval)", suppliers.defaultCostCenterId),
          ref(fixedAssetCategories, "fixed_asset_categories", "tillgångsgrupp (förval)|tillgångsgrupper (förval)", fixedAssetCategories.defaultCostCenterId),
          { ...ref(budgetLines, "budget_lines", "budgetrad|budgetrader", budgetLines.costCenterId), move: moveBudgetLines },
        ]
      : []),
  ];
}

const COST_CENTER_REFERENCES = references("costCenter");
const PROJECT_REFERENCES = references("project");

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
    return r.condition ? r.condition(id) : eq(r.column, id);
  }

  async function countReferences(references: DimensionReference[], id: string): Promise<RegisterUsage> {
    const found: RegisterUsage["references"] = [];
    for (const r of references) {
      const [row] = await db.select({ n: count() }).from(r.table).where(whereFor(r, id));
      const n = Number(row?.n ?? 0);
      if (n > 0) found.push({ table: r.tableName, label: r.label, labelOne: r.labelOne, count: n, blocksReplacement: r.locked });
    }
    return { total: found.reduce((sum, r) => sum + r.count, 0), references: found };
  }

  // Any booked verification row or locked document carrying the object.
  async function hasLockedReferences(references: DimensionReference[], id: string): Promise<boolean> {
    for (const r of references) {
      if (!r.locked) continue;
      const [row] = await db.select({ n: count() }).from(r.table).where(whereFor(r, id));
      if (Number(row?.n ?? 0) > 0) return true;
    }
    return false;
  }

  // Moves every movable reference to `replacementId` (when given) and
  // deletes the entry in one transaction. Locked references are never
  // touched: the service refuses an object they carry up front
  // (hasLockedReferences → DimensionBookedError) — and the FK on the final
  // DELETE is the race guard for a row booked in between (RegisterEntryInUseError).
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
            if (r.locked) continue;
            const [before] = await tx.select({ n: count() }).from(r.table).where(whereFor(r, entry.id));
            const n = Number(before?.n ?? 0);
            if (n === 0) continue;
            if (r.move) await r.move(tx, entry.id, replacementId);
            else await tx.execute(sql`UPDATE ${r.table} SET ${sql.identifier(r.column.name)} = ${replacementId} WHERE ${whereFor(r, entry.id)}`);
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
      async hasLockedReferences(id: string) {
        return hasLockedReferences(COST_CENTER_REFERENCES, id);
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
      async hasLockedReferences(id: string) {
        return hasLockedReferences(PROJECT_REFERENCES, id);
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

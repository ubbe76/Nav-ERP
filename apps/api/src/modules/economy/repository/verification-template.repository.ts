import { and, asc, count, eq, inArray, sql } from "drizzle-orm";
import {
  accounts,
  recurringVerifications,
  verificationSeries,
  verificationTemplateRows,
  verificationTemplates,
  type Db,
  type Tx,
} from "@navet/db";

// Verifikatmallar (snabbare manuell bokföring). Rows carry account NUMBERS;
// the account name is joined at read time (null when the chart no longer
// has the number) so a template never breaks when the chart changes.

export type TemplateRowWrite = {
  accountNumber: string;
  description: string | null;
  debit: number | null;
  credit: number | null;
};

export type TemplateHeaderWrite = {
  name: string;
  seriesId: string;
  description: string;
};

export type TemplateHeaderPatch = Partial<TemplateHeaderWrite> & { active?: boolean };

export interface VerificationTemplateRowView {
  id: string;
  accountNumber: string;
  accountName: string | null;
  description: string | null;
  debit: number | null;
  credit: number | null;
  sortOrder: number;
}

export interface VerificationTemplateView {
  id: string;
  name: string;
  seriesId: string;
  seriesCode: string;
  description: string;
  active: boolean;
  rows: VerificationTemplateRowView[];
  createdAt: Date;
  updatedAt: Date;
}

export function createVerificationTemplateRepository(db: Db) {
  async function rowsFor(executor: Db | Tx, templateIds: string[]): Promise<Map<string, VerificationTemplateRowView[]>> {
    const byTemplate = new Map<string, VerificationTemplateRowView[]>();
    if (templateIds.length === 0) return byTemplate;
    const rows = await executor
      .select({
        id: verificationTemplateRows.id,
        templateId: verificationTemplateRows.templateId,
        accountNumber: verificationTemplateRows.accountNumber,
        accountName: accounts.name,
        description: verificationTemplateRows.description,
        debit: verificationTemplateRows.debit,
        credit: verificationTemplateRows.credit,
        sortOrder: verificationTemplateRows.sortOrder,
      })
      .from(verificationTemplateRows)
      .leftJoin(accounts, eq(accounts.number, verificationTemplateRows.accountNumber))
      .where(inArray(verificationTemplateRows.templateId, templateIds))
      .orderBy(asc(verificationTemplateRows.templateId), asc(verificationTemplateRows.sortOrder));
    for (const row of rows) {
      const list = byTemplate.get(row.templateId) ?? [];
      list.push({
        id: row.id,
        accountNumber: row.accountNumber,
        accountName: row.accountName ?? null,
        description: row.description,
        debit: row.debit === null ? null : Number(row.debit),
        credit: row.credit === null ? null : Number(row.credit),
        sortOrder: row.sortOrder,
      });
      byTemplate.set(row.templateId, list);
    }
    return byTemplate;
  }

  async function headers(executor: Db | Tx, where: ReturnType<typeof and> | undefined) {
    return executor
      .select({
        id: verificationTemplates.id,
        name: verificationTemplates.name,
        seriesId: verificationTemplates.seriesId,
        seriesCode: verificationSeries.code,
        description: verificationTemplates.description,
        active: verificationTemplates.active,
        createdAt: verificationTemplates.createdAt,
        updatedAt: verificationTemplates.updatedAt,
      })
      .from(verificationTemplates)
      .innerJoin(verificationSeries, eq(verificationSeries.id, verificationTemplates.seriesId))
      .where(where)
      .orderBy(asc(verificationTemplates.name));
  }

  async function insertRows(tx: Tx, templateId: string, rows: TemplateRowWrite[]) {
    if (rows.length === 0) return;
    await tx.insert(verificationTemplateRows).values(
      rows.map((row, index) => ({
        templateId,
        accountNumber: row.accountNumber,
        description: row.description,
        debit: row.debit === null ? null : String(row.debit),
        credit: row.credit === null ? null : String(row.credit),
        sortOrder: index,
      }))
    );
  }

  return {
    async list(includeInactive: boolean): Promise<{ rows: VerificationTemplateView[]; total: number }> {
      const where = includeInactive ? undefined : eq(verificationTemplates.active, true);
      const [heads, totalRows] = await Promise.all([
        headers(db, where),
        db.select({ total: count() }).from(verificationTemplates).where(where),
      ]);
      const rows = await rowsFor(
        db,
        heads.map((h) => h.id)
      );
      return { rows: heads.map((h) => ({ ...h, rows: rows.get(h.id) ?? [] })), total: totalRows[0]!.total };
    },

    async findById(id: string, executor: Db | Tx = db): Promise<VerificationTemplateView | null> {
      const [head] = await headers(executor, eq(verificationTemplates.id, id));
      if (!head) return null;
      const rows = await rowsFor(executor, [id]);
      return { ...head, rows: rows.get(id) ?? [] };
    },

    async findByName(name: string) {
      const [row] = await db.select({ id: verificationTemplates.id }).from(verificationTemplates).where(eq(verificationTemplates.name, name));
      return row ?? null;
    },

    // Header + rows in one transaction. Composable (tx) for the fördelning,
    // which creates its template and its recurring post together.
    async create(header: TemplateHeaderWrite, rows: TemplateRowWrite[], createdBy: string | null, tx?: Tx) {
      const run = async (t: Tx) => {
        const [template] = await t
          .insert(verificationTemplates)
          .values({ name: header.name, seriesId: header.seriesId, description: header.description, createdBy })
          .returning({ id: verificationTemplates.id });
        await insertRows(t, template!.id, rows);
        return template!.id;
      };
      return tx ? run(tx) : db.transaction(run);
    },

    // Header patch and/or a full row replacement, one transaction. null when
    // the template does not exist.
    async update(id: string, patch: TemplateHeaderPatch, rows: TemplateRowWrite[] | undefined) {
      return db.transaction(async (tx) => {
        const [existing] = await tx.select({ id: verificationTemplates.id }).from(verificationTemplates).where(eq(verificationTemplates.id, id)).for("update");
        if (!existing) return null;
        await tx
          .update(verificationTemplates)
          .set({ ...patch, updatedAt: new Date() })
          .where(eq(verificationTemplates.id, id));
        if (rows !== undefined) {
          await tx.delete(verificationTemplateRows).where(eq(verificationTemplateRows.templateId, id));
          await insertRows(tx, id, rows);
        }
        return existing.id;
      });
    },

    async delete(id: string) {
      const [row] = await db.delete(verificationTemplates).where(eq(verificationTemplates.id, id)).returning({ id: verificationTemplates.id });
      return row ?? null;
    },

    // The recurring posts (any status) that still reference the template —
    // the friendly check in front of the restrict FK.
    async usedByRecurring(id: string): Promise<boolean> {
      const [row] = await db
        .select({ one: sql`1` })
        .from(recurringVerifications)
        .where(eq(recurringVerifications.templateId, id))
        .limit(1);
      return row !== undefined;
    },

    // Existence of the account numbers a template names — a template may
    // reference an inactive account (it is resolved to an active one when
    // used), but never one the chart lacks.
    async existingAccountNumbers(numbers: string[]): Promise<Set<string>> {
      if (numbers.length === 0) return new Set();
      const rows = await db
        .select({ number: accounts.number })
        .from(accounts)
        .where(and(inArray(accounts.number, [...new Set(numbers)])));
      return new Set(rows.map((r) => r.number));
    },
  };
}

export type VerificationTemplateRepository = ReturnType<typeof createVerificationTemplateRepository>;

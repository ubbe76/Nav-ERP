import { and, asc, eq, gte, lte, sql, type SQL } from "drizzle-orm";
import { accounts, customers, projects, salesOrderRows, salesOrders, verificationRows, verifications, type Db } from "@navet/db";
import type { ProjectRowSource } from "../service/project-report.js";

// Projektrapport: the project header, the BOOKED verification rows that
// carry it (optionally within [from, to]) and the customer orders pointing at
// it. The pure builder in project-report.ts does the arithmetic.

export interface ProjectHeader {
  id: string;
  code: string;
  name: string;
  status: string;
  customerName: string | null;
}

export interface ProjectSalesOrderRow {
  id: string;
  orderNumber: string;
  status: string;
  // Σ rows (antal × à-pris × (1 − rabatt)) in SEK, like the offertuppföljning.
  value: number;
}

const rowValue = sql<string>`coalesce((
  select sum(r.quantity_ordered * r.unit_price * (1 - r.discount_percent / 100))
  from ${salesOrderRows} r where r.sales_order_id = ${salesOrders.id}
), 0)`;

export function createProjectReportRepository(db: Db) {
  return {
    async findProject(id: string): Promise<ProjectHeader | null> {
      const [row] = await db
        .select({ id: projects.id, code: projects.code, name: projects.name, status: projects.status, customerName: customers.name })
        .from(projects)
        .leftJoin(customers, eq(customers.id, projects.customerId))
        .where(eq(projects.id, id));
      return row ?? null;
    },

    async loadRows(projectId: string, range: { from?: string; to?: string }): Promise<ProjectRowSource[]> {
      const conditions: SQL[] = [eq(verificationRows.projectId, projectId), eq(verifications.status, "booked")];
      if (range.from) conditions.push(gte(verifications.date, range.from));
      if (range.to) conditions.push(lte(verifications.date, range.to));
      const rows = await db
        .select({
          date: verifications.date,
          accountNumber: accounts.number,
          accountName: accounts.name,
          debit: verificationRows.debit,
          credit: verificationRows.credit,
        })
        .from(verificationRows)
        .innerJoin(verifications, eq(verifications.id, verificationRows.verificationId))
        .innerJoin(accounts, eq(accounts.id, verificationRows.accountId))
        .where(and(...conditions))
        .orderBy(asc(verifications.date), asc(accounts.number));
      return rows.map((row) => ({ ...row, debit: Number(row.debit), credit: Number(row.credit) }));
    },

    async loadSalesOrders(projectId: string): Promise<ProjectSalesOrderRow[]> {
      const rows = await db
        .select({
          id: salesOrders.id,
          orderNumber: salesOrders.orderNumber,
          status: salesOrders.status,
          value: sql<string>`round(${rowValue} * ${salesOrders.exchangeRate}, 2)`,
        })
        .from(salesOrders)
        .where(eq(salesOrders.projectId, projectId))
        .orderBy(asc(salesOrders.createdAt), asc(salesOrders.orderNumber));
      return rows.map((row) => ({ ...row, value: Number(row.value) }));
    },
  };
}

export type ProjectReportRepository = ReturnType<typeof createProjectReportRepository>;

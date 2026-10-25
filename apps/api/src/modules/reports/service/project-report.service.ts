import { buildCsv, type CsvColumn, type ProjectReport, type ProjectReportQuery } from "@navet/shared";
import { ProjectNotFoundError } from "../../economy/service/dimension-check.js";
import { SALES_ORDER_STATUS_LABELS } from "../../sales/service/export-columns.js";
import type { ProjectReportRepository } from "../repository/project-report.repository.js";
import { buildProjectReport } from "./project-report.js";

export { ProjectNotFoundError };

// Projektrapport: one project's revenue, costs and result out of the booked
// rows that carry it, per month and per account, plus its customer orders.
// from/to optional = all time; the response then echoes the first and last
// booked day of the project's rows (null without rows) so the heading can
// still name a range.

// CSV = the months, then the accounts, then the orders — one flat table with
// a "Typ" column, since the web shows three tables.
type CsvRow = { typ: string; nyckel: string; namn: string; intakter: number | null; kostnader: number | null; resultat: number | null; status: string | null; varde: number | null };

const CSV_COLUMNS: CsvColumn<CsvRow>[] = [
  { label: "Typ", value: (r) => r.typ },
  { label: "Månad/Konto/Order", value: (r) => r.nyckel },
  { label: "Benämning", value: (r) => r.namn },
  { label: "Intäkter", value: (r) => r.intakter, format: "money" },
  { label: "Kostnader", value: (r) => r.kostnader, format: "money" },
  { label: "Resultat", value: (r) => r.resultat, format: "money" },
  { label: "Status", value: (r) => r.status },
  { label: "Ordervärde", value: (r) => r.varde, format: "money" },
];

export function createProjectReportService(repo: ProjectReportRepository) {
  const service = {
    async get(query: ProjectReportQuery): Promise<ProjectReport> {
      const project = await repo.findProject(query.projectId);
      if (!project) throw new ProjectNotFoundError(query.projectId);
      const [rows, salesOrders] = await Promise.all([
        repo.loadRows(query.projectId, { from: query.from, to: query.to }),
        repo.loadSalesOrders(query.projectId),
      ]);
      const totals = buildProjectReport(rows);
      const dates = rows.map((row) => row.date).sort();
      return {
        project,
        from: query.from ?? dates[0] ?? null,
        to: query.to ?? dates[dates.length - 1] ?? null,
        ...totals,
        salesOrders,
      };
    },

    async getCsv(query: ProjectReportQuery) {
      const report = await service.get(query);
      const rows: CsvRow[] = [
        ...report.months.map((m) => ({ typ: "Månad", nyckel: m.month, namn: "", intakter: m.revenue, kostnader: m.costs, resultat: m.result, status: null, varde: null })),
        ...report.accounts.map((a) => ({ typ: "Konto", nyckel: a.accountNumber, namn: a.accountName, intakter: null, kostnader: null, resultat: a.amount, status: null, varde: null })),
        ...report.salesOrders.map((o) => ({
          typ: "Kundorder",
          nyckel: o.orderNumber,
          namn: "",
          intakter: null,
          kostnader: null,
          resultat: null,
          status: SALES_ORDER_STATUS_LABELS[o.status as keyof typeof SALES_ORDER_STATUS_LABELS] ?? o.status,
          varde: o.value,
        })),
        { typ: "Totalt", nyckel: "", namn: report.project.name, intakter: report.revenue, kostnader: report.costs, resultat: report.result, status: null, varde: null },
      ];
      const suffix = report.from && report.to ? `-${report.from}--${report.to}` : "";
      return { filename: `projektrapport-${report.project.code}${suffix}.csv`, content: buildCsv(CSV_COLUMNS, rows) };
    },
  };
  return service;
}

export type ProjectReportService = ReturnType<typeof createProjectReportService>;

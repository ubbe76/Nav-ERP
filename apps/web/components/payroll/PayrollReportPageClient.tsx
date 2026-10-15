"use client";

import Link from "next/link";
import { API_URL } from "../../lib/api";
import { Table } from "../ui/Table";
import { StatusPill } from "../ui/StatusPill";
import { Card } from "../ui/Card";
import { FormHint, FormNotice } from "../ui/Form";
import buttonStyles from "../ui/Button.module.css";
import { formatHours } from "../timereport/SchedulesPageClient";
import { shiftMonth } from "./AttestationPageClient";
import type { PeriodEmployeeSummary, PeriodSummary } from "../../lib/types";
import { SectionHeading } from "../ui/SectionHeading";

// The Table needs an `id`; the summary rows are keyed by employeeId.
type EmployeeRow = PeriodEmployeeSummary & { id: string };

function sumMinutes(entries: { minutes: number }[]): number {
  return entries.reduce((total, entry) => total + entry.minutes, 0);
}

// Comp-time share of overtime (payout = total − comp) — split into their own
// columns here, unlike Attestering's merged Övertid column.
const compMinutes = (e: EmployeeRow) => (e.overtimeCompMinutes ?? 0) + (e.overtimeOffScheduleCompMinutes ?? 0);
const payoutMinutes = (e: EmployeeRow) => e.overtimeMinutes + e.overtimeOffScheduleMinutes - compMinutes(e);

// Same columns as Attestering, minus the action column — this page is a
// read-only report, not a correction workflow.
const COLUMNS = [
  { key: "name", label: "Anställd", width: "1fr" },
  { key: "scheduledMinutes", label: "Schema", width: "90px", align: "right" as const },
  { key: "workedMinutes", label: "Arbetat", width: "90px", align: "right" as const },
  { key: "absence", label: "Frånvaro", width: "90px", align: "right" as const },
  { key: "overtimePayout", label: "Övertid utbet.", width: "110px", align: "right" as const },
  { key: "overtimeComp", label: "Övertid komp", width: "110px", align: "right" as const },
  { key: "ob", label: "OB", width: "80px", align: "right" as const },
  { key: "atfMinutes", label: "ATF", width: "80px", align: "right" as const },
  { key: "unaccountedMinutes", label: "Ofördelat", width: "110px", align: "right" as const },
  { key: "status", label: "Status", width: "160px" },
];

// Mirrors AttestationPageClient's statusCell, minus the attest/unattest
// actions that belong to the Attestering workflow, not this report.
function renderCell(employee: EmployeeRow, key: string, locked: boolean) {
  switch (key) {
    case "name":
      return (
        <span style={{ display: "flex", flexDirection: "column", gap: 2 }}>
          <strong>{employee.name}</strong>
          <span className="num" style={{ fontSize: 12, color: "var(--color-text-secondary)" }}>
            {employee.employeeNumber}
          </span>
        </span>
      );
    case "scheduledMinutes":
    case "workedMinutes":
    case "atfMinutes":
      return <span className="num">{formatHours(employee[key])}</span>;
    case "absence":
      return <span className="num">{formatHours(sumMinutes(employee.absence))}</span>;
    case "overtimePayout":
      return <span className="num">{formatHours(payoutMinutes(employee))}</span>;
    case "overtimeComp":
      return <span className="num">{formatHours(compMinutes(employee))}</span>;
    case "ob":
      return <span className="num">{formatHours(sumMinutes(employee.ob))}</span>;
    case "unaccountedMinutes":
      return (
        <span
          className="num"
          style={
            employee.unaccountedMinutes > 0
              ? { color: "var(--status-stopped-text)", fontWeight: 600 }
              : undefined
          }
        >
          {formatHours(employee.unaccountedMinutes)}
        </span>
      );
    case "status":
      if (!locked && employee.openAttendance) return <StatusPill status="stopped" label="Öppen närvaro" compact />;
      if (!employee.attested) return <StatusPill status="draft" label="Ej attesterad" compact />;
      return (
        <span style={{ display: "inline-flex", flexDirection: "column", gap: 2 }}>
          <StatusPill status="done" label="Attesterad" compact />
          {employee.attestedByName && (
            <span style={{ fontSize: 12, color: "var(--color-text-secondary)" }}>
              {employee.attestedByName}
              {employee.attestedAt && ` · ${new Date(employee.attestedAt).toLocaleDateString("sv-SE")}`}
            </span>
          )}
        </span>
      );
    default:
      return null;
  }
}

// Sum row under each section — same fields as the columns, in the same
// minutes-to-hours formatting.
function sectionFooter(employees: EmployeeRow[]) {
  return {
    name: <strong>Totalt ({employees.length})</strong>,
    scheduledMinutes: (
      <span className="num">{formatHours(employees.reduce((total, e) => total + e.scheduledMinutes, 0))}</span>
    ),
    workedMinutes: (
      <span className="num">{formatHours(employees.reduce((total, e) => total + e.workedMinutes, 0))}</span>
    ),
    absence: (
      <span className="num">
        {formatHours(employees.reduce((total, e) => total + sumMinutes(e.absence), 0))}
      </span>
    ),
    overtimePayout: (
      <span className="num">{formatHours(employees.reduce((total, e) => total + payoutMinutes(e), 0))}</span>
    ),
    overtimeComp: (
      <span className="num">{formatHours(employees.reduce((total, e) => total + compMinutes(e), 0))}</span>
    ),
    ob: <span className="num">{formatHours(employees.reduce((total, e) => total + sumMinutes(e.ob), 0))}</span>,
    atfMinutes: (
      <span className="num">{formatHours(employees.reduce((total, e) => total + e.atfMinutes, 0))}</span>
    ),
    unaccountedMinutes: (
      <span className="num">
        {formatHours(employees.reduce((total, e) => total + e.unaccountedMinutes, 0))}
      </span>
    ),
  };
}

// One employmentType group: a heading, an optional warning (the "no
// employmentType set" group), the table itself and its totals footer.
function Section({
  title,
  employees,
  locked,
  hint,
  emptyText,
  first,
}: {
  title: string;
  employees: EmployeeRow[];
  locked: boolean;
  hint?: string;
  emptyText: string;
  first?: boolean;
}) {
  return (
    <div style={{ marginTop: first ? 24 : 32 }}>
      <SectionHeading>
        {title} ({employees.length})
      </SectionHeading>
      {hint && <FormNotice style={{ marginBottom: 10 }}>{hint}</FormNotice>}
      <Table<EmployeeRow>
        columns={COLUMNS}
        rows={employees}
        emptyText={emptyText}
        renderCell={(employee, key) => renderCell(employee, key, locked)}
        footer={employees.length > 0 ? sectionFooter(employees) : undefined}
      />
    </div>
  );
}

// Löneunderlag — the read-only monthly report: same underlag as Attestering,
// grouped by anställningsform, with CSV/PDF/PAXml downloads. Timlön employees
// are paid out their full reported time; månadslön employees' report is
// mainly about deviations (frånvaro/övertid/OB) from the fixed salary.
export function PayrollReportPageClient({
  summary,
  year,
  month,
}: {
  summary: PeriodSummary;
  year: number;
  month: number;
}) {
  const locked = summary.status === "locked";
  const rows: EmployeeRow[] = summary.employees.map((employee) => ({ ...employee, id: employee.employeeId }));
  const hourly = rows.filter((employee) => employee.employmentType === "hourly");
  const monthly = rows.filter((employee) => employee.employmentType === "monthly");
  const unspecified = rows.filter((employee) => employee.employmentType === null);
  const previous = shiftMonth(year, month, -1);
  const next = shiftMonth(year, month, 1);

  return (
    <>
      <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginBottom: 14 }}>
        <Link
          href={`/tillverkning/loneunderlag?year=${previous.year}&month=${previous.month}`}
          className={`${buttonStyles.button} ${buttonStyles.ghost}`}
        >
          ◀ Föregående
        </Link>
        <Link
          href={`/tillverkning/loneunderlag?year=${next.year}&month=${next.month}`}
          className={`${buttonStyles.button} ${buttonStyles.ghost}`}
        >
          Nästa ▶
        </Link>
      </div>

      <Card maxWidth="none">
        <div style={{ display: "flex", gap: 10, flexWrap: "wrap", alignItems: "center" }}>
          <a
            className={`${buttonStyles.button} ${buttonStyles.ghost}`}
            href={`${API_URL}/api/v1/periods/${year}/${month}/csv`}
            download
          >
            Ladda ner CSV
          </a>
          <a
            className={`${buttonStyles.button} ${buttonStyles.ghost}`}
            href={`${API_URL}/api/v1/periods/${year}/${month}/pdf`}
            download
          >
            Ladda ner PDF
          </a>
          {locked ? (
            <a
              className={`${buttonStyles.button} ${buttonStyles.ghost}`}
              href={`${API_URL}/api/v1/periods/${year}/${month}/paxml`}
              download
            >
              Exportera PAXml
            </a>
          ) : (
            <span
              className={`${buttonStyles.button} ${buttonStyles.ghost}`}
              style={{ cursor: "not-allowed", opacity: 0.5 }}
              aria-disabled="true"
              title="Perioden måste vara låst innan PAXml kan exporteras"
            >
              Exportera PAXml
            </span>
          )}
        </div>
        {!locked && <FormHint attached>Perioden måste vara låst innan PAXml kan exporteras</FormHint>}
      </Card>

      {rows.length === 0 ? (
        <Card maxWidth="none" style={{ marginTop: 24 }}>
          <FormHint>Inga medarbetare med underlag i perioden.</FormHint>
        </Card>
      ) : (
        <>
          <Section
            title="Timlön"
            employees={hourly}
            locked={locked}
            emptyText="Inga anställda med timlön i perioden"
            first
          />
          <Section
            title="Månadslön"
            employees={monthly}
            locked={locked}
            emptyText="Inga anställda med månadslön i perioden"
          />
          {unspecified.length > 0 && (
            <Section
              title="Ej angiven anställningsform"
              employees={unspecified}
              locked={locked}
              hint="Dessa anställda saknar anställningsform på personalkortet och kan inte placeras under Timlön eller Månadslön — komplettera anställningsformen för korrekt löneunderlag."
              emptyText="Inga anställda"
            />
          )}
        </>
      )}
    </>
  );
}

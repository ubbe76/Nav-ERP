"use client";

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { Card } from "../ui/Card";
import { Field, Input, Select } from "../ui/Field";
import { FormError, FormRow } from "../ui/Form";
import { Table } from "../ui/Table";
import { API_URL, apiFetch } from "../../lib/api";
import { formatMoney } from "../../lib/format";
import buttonStyles from "../ui/Button.module.css";
import { useDimensions } from "../../lib/dimensions";
import type { FiscalYear, IncomeStatementColumn, IncomeStatementResponse } from "../../lib/types";
import { CostCenterSelect, ProjectSelect } from "./DimensionSelect";
import styles from "./Resultatrakning.module.css";

type GroupBy = "" | "costCenter" | "project";

function columnLabel(c: IncomeStatementColumn): string {
  return c.code ? `${c.code} ${c.name}` : c.name;
}

type StatementRow =
  | { id: string; kind: "line" | "subtotal"; label: string; total: number }
  | {
      id: string;
      kind: "account";
      accountId: string;
      accountNumber: string;
      accountName: string;
      amount: number;
    };

function flatten(report: IncomeStatementResponse): StatementRow[] {
  const rows: StatementRow[] = [];
  for (const entry of report.entries) {
    if (entry.kind === "subtotal") {
      rows.push({ id: `s-${entry.key}`, kind: "subtotal", label: entry.label, total: entry.total });
      continue;
    }
    rows.push({ id: `l-${entry.key}`, kind: "line", label: entry.label, total: entry.total });
    for (const account of entry.accounts) {
      rows.push({
        id: `a-${account.accountId}`,
        kind: "account",
        accountId: account.accountId,
        accountNumber: account.accountNumber,
        accountName: account.accountName,
        amount: account.amount,
      });
    }
  }
  return rows;
}

export function ResultatrakningPageClient({
  fiscalYears,
  defaultFrom,
  defaultTo,
  defaultCostCenterId,
  defaultProjectId,
  defaultGroupBy,
}: {
  fiscalYears: FiscalYear[];
  defaultFrom?: string;
  defaultTo?: string;
  defaultCostCenterId?: string;
  defaultProjectId?: string;
  defaultGroupBy?: string;
}) {
  const router = useRouter();
  const pathname = usePathname();

  // Same default as the huvudbok page: the latest fiscal year's bounds,
  // falling back to the current calendar year when none exists yet.
  const fallbackYear = new Date().getFullYear();
  const initial = useMemo(
    () => ({
      from: defaultFrom ?? fiscalYears[0]?.startDate ?? `${fallbackYear}-01-01`,
      to: defaultTo ?? fiscalYears[0]?.endDate ?? `${fallbackYear}-12-31`,
    }),
    [defaultFrom, defaultTo, fiscalYears, fallbackYear]
  );
  const [from, setFrom] = useState(initial.from);
  const [to, setTo] = useState(initial.to);
  const dims = useDimensions();
  const [costCenterId, setCostCenterId] = useState(defaultCostCenterId ?? "");
  const [projectId, setProjectId] = useState(defaultProjectId ?? "");
  const [groupBy, setGroupBy] = useState<GroupBy>(
    defaultGroupBy === "costCenter" || defaultGroupBy === "project" ? defaultGroupBy : ""
  );
  const [report, setReport] = useState<IncomeStatementResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  // The same query string drives the screen, the URL, the PDF and the CSV.
  const query = new URLSearchParams({ from, to });
  if (costCenterId) query.set("costCenterId", costCenterId);
  if (projectId) query.set("projectId", projectId);
  if (groupBy) query.set("groupBy", groupBy);
  const queryString = query.toString();
  const showDimensionControls = dims.allCostCenters.length > 0 || dims.allProjects.length > 0 || groupBy !== "";

  useEffect(() => {
    let cancelled = false;
    setPending(true);
    setError(null);
    apiFetch<IncomeStatementResponse>(`/api/v1/income-statement?${queryString}`)
      .then((data) => {
        if (cancelled) return;
        setReport(data);
      })
      .catch((err: Error) => {
        if (cancelled) return;
        setReport(null);
        setError(err.message);
      })
      .finally(() => {
        if (!cancelled) setPending(false);
      });
    return () => {
      cancelled = true;
    };
  }, [queryString]);

  useEffect(() => {
    router.replace(`${pathname}?${queryString}`, { scroll: false });
  }, [queryString, pathname, router]);

  const columns = report?.columns && groupBy ? report.columns : null;
  const rows = report && !columns ? flatten(report) : [];

  return (
    <>
      <Card>
        <FormRow>
          <Field label="Från">
            <Input type="date" size="sm" value={from} onChange={(e) => setFrom(e.target.value)} />
          </Field>
          <Field label="Till">
            <Input type="date" size="sm" value={to} onChange={(e) => setTo(e.target.value)} />
          </Field>
          {report && (
            <a
              href={`${API_URL}/api/v1/income-statement/pdf?${queryString}`}
              download
              className={`${buttonStyles.button} ${buttonStyles.ghost}`}
            >
              Ladda ner PDF
            </a>
          )}
          {report && (
            <a
              href={`${API_URL}/api/v1/income-statement/csv?${queryString}`}
              download
              className={`${buttonStyles.button} ${buttonStyles.ghost}`}
            >
              Ladda ner CSV
            </a>
          )}
        </FormRow>
        {showDimensionControls && (
          <FormRow columns={3}>
            <Field label="Kostnadsställe" htmlFor="incomeCostCenter">
              <CostCenterSelect id="incomeCostCenter" all={dims.allCostCenters} value={costCenterId} onChange={setCostCenterId} emptyLabel="Alla kostnadsställen" />
            </Field>
            <Field label="Projekt" htmlFor="incomeProject">
              <ProjectSelect id="incomeProject" all={dims.allProjects} value={projectId} onChange={setProjectId} emptyLabel="Alla projekt" />
            </Field>
            <Field label="Visa" htmlFor="incomeGroupBy">
              <Select id="incomeGroupBy" value={groupBy} onChange={(e) => setGroupBy(e.target.value as GroupBy)}>
                <option value="">Totalt</option>
                <option value="costCenter">Per kostnadsställe</option>
                <option value="project">Per projekt</option>
              </Select>
            </Field>
          </FormRow>
        )}
      </Card>

      {error && <FormError>{error}</FormError>}

      {report && !pending && columns && <ObjectMatrix report={report} columns={columns} from={from} to={to} />}

      {report && !pending && !columns && (
        <Card>
          <Table<StatementRow>
            columns={[
              { key: "account", label: "Konto", width: "110px" },
              { key: "label", label: "Benämning", width: "1.6fr" },
              { key: "amount", label: "Belopp", width: "160px", align: "right" },
            ]}
            rows={rows}
            renderCell={(row, key) => {
              if (row.kind === "account") {
                switch (key) {
                  case "account":
                    return (
                      <Link href={`/ekonomi/huvudbok?accountId=${row.accountId}&from=${from}&to=${to}`}>
                        {row.accountNumber}
                      </Link>
                    );
                  case "label":
                    return <span style={{ paddingLeft: 16 }}>{row.accountName}</span>;
                  case "amount":
                    return <span className="num">{formatMoney(row.amount)}</span>;
                }
                // Exhaustive return so the union narrows below.
                return "";
              }
              switch (key) {
                case "label":
                  return row.kind === "subtotal" ? (
                    <strong>{row.label}</strong>
                  ) : (
                    <span style={{ fontWeight: 500 }}>{row.label}</span>
                  );
                case "amount":
                  return (
                    <span className="num" style={{ fontWeight: 600 }}>
                      {formatMoney(row.total)}
                    </span>
                  );
                default:
                  return "";
              }
            }}
          />
        </Card>
      )}
    </>
  );
}

// One column per object (and "Utan") plus the sum. Scrolls sideways inside its
// own box on narrow screens.
function ObjectMatrix({ report, columns, from, to }: { report: IncomeStatementResponse; columns: IncomeStatementColumn[]; from: string; to: string }) {
  const money = (n: number | undefined) => (n === undefined ? "" : formatMoney(n));
  return (
    <Card maxWidth="none">
      <div className={styles.scroller}>
        <table className={styles.matrix}>
          <thead>
            <tr>
              <th className={styles.labelCell}>Konto / benämning</th>
              {columns.map((c) => (
                <th key={c.id ?? "none"} className={styles.amountCell}>
                  {columnLabel(c)}
                </th>
              ))}
              <th className={`${styles.amountCell} ${styles.sumCell}`}>Summa</th>
            </tr>
          </thead>
          <tbody>
            {report.entries.flatMap((entry) => {
              const head = (
                <tr key={`e-${entry.key}`} className={entry.kind === "subtotal" ? styles.subtotalRow : styles.lineRow}>
                  <td className={styles.labelCell}>{entry.label}</td>
                  {columns.map((c, i) => (
                    <td key={c.id ?? "none"} className={`${styles.amountCell} num`}>
                      {money(entry.amounts?.[i])}
                    </td>
                  ))}
                  <td className={`${styles.amountCell} ${styles.sumCell} num`}>{formatMoney(entry.total)}</td>
                </tr>
              );
              if (entry.kind === "subtotal") return [head];
              return [
                head,
                ...entry.accounts.map((a) => (
                  <tr key={`a-${entry.key}-${a.accountId}`} className={styles.accountRow}>
                    <td className={styles.labelCell}>
                      <Link href={`/ekonomi/huvudbok?accountId=${a.accountId}&from=${from}&to=${to}`}>{a.accountNumber}</Link> {a.accountName}
                    </td>
                    {columns.map((c, i) => (
                      <td key={c.id ?? "none"} className={`${styles.amountCell} num`}>
                        {money(a.amounts?.[i])}
                      </td>
                    ))}
                    <td className={`${styles.amountCell} ${styles.sumCell} num`}>{formatMoney(a.amount)}</td>
                  </tr>
                )),
              ];
            })}
          </tbody>
        </table>
      </div>
    </Card>
  );
}

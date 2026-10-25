"use client";

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { Card } from "../ui/Card";
import { Field, Input, Select } from "../ui/Field";
import { FormError, FormHint, FormRow } from "../ui/Form";
import { Table } from "../ui/Table";
import { API_URL, apiFetch } from "../../lib/api";
import { apiErrorMessage } from "../../lib/errorMessages";
import { formatMoney, formatPercent } from "../../lib/format";
import buttonStyles from "../ui/Button.module.css";
import { useDimensions } from "../../lib/dimensions";
import type {
  BudgetFigures,
  BudgetSummary,
  FiscalYear,
  IncomeStatementColumn,
  IncomeStatementResponse,
} from "../../lib/types";
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
      accountId: string | null;
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
        id: `a-${entry.key}-${account.accountNumber}`,
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

// Budget on the report: the year's budgets are offered for the fiscal year
// that contains `from`; the year's default is preselected, "Ingen" is kept in
// the URL as budgetId=none so a reload does not bring the default back.
const NO_BUDGET = "none";

export function ResultatrakningPageClient({
  fiscalYears,
  defaultFrom,
  defaultTo,
  defaultCostCenterId,
  defaultProjectId,
  defaultGroupBy,
  defaultBudgetId,
}: {
  fiscalYears: FiscalYear[];
  defaultFrom?: string;
  defaultTo?: string;
  defaultCostCenterId?: string;
  defaultProjectId?: string;
  defaultGroupBy?: string;
  defaultBudgetId?: string;
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
  const [budgets, setBudgets] = useState<BudgetSummary[]>([]);
  const [budgetId, setBudgetId] = useState(defaultBudgetId && defaultBudgetId !== NO_BUDGET ? defaultBudgetId : "");
  // true once the user (or the URL) has made a choice — then the year's
  // default budget is never selected over it.
  const [budgetChosen, setBudgetChosen] = useState(defaultBudgetId !== undefined);
  const budgetYearId = fiscalYears.find((y) => y.startDate <= from && from <= y.endDate)?.id ?? "";
  const [budgetsLoaded, setBudgetsLoaded] = useState(budgetYearId === "");
  const [report, setReport] = useState<IncomeStatementResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  // The same query string drives the screen, the URL, the PDF and the CSV.
  const budgetBlocked = projectId !== "" || groupBy !== "";
  const query = new URLSearchParams({ from, to });
  if (costCenterId) query.set("costCenterId", costCenterId);
  if (projectId) query.set("projectId", projectId);
  if (groupBy) query.set("groupBy", groupBy);
  const urlQuery = new URLSearchParams(query);
  if (budgetId) urlQuery.set("budgetId", budgetId);
  else if (budgetChosen) urlQuery.set("budgetId", NO_BUDGET);
  // Budget cannot be combined with Projekt or Per kostnadsställe/Per projekt.
  if (budgetId && !budgetBlocked) query.set("budgetId", budgetId);
  const queryString = query.toString();
  const urlQueryString = urlQuery.toString();
  const showDimensionControls = dims.allCostCenters.length > 0 || dims.allProjects.length > 0 || groupBy !== "";

  // The budgets of the fiscal year that contains `from`.
  useEffect(() => {
    if (budgetYearId === "") {
      setBudgets([]);
      setBudgetsLoaded(true);
      return;
    }
    let cancelled = false;
    setBudgetsLoaded(false);
    apiFetch<{ rows: BudgetSummary[] }>(`/api/v1/budgets?fiscalYearId=${budgetYearId}`)
      .then((data) => data.rows)
      .catch(() => [] as BudgetSummary[])
      .then((rows) => {
        if (cancelled) return;
        setBudgets(rows);
        setBudgetId((current) => {
          if (current && rows.some((b) => b.id === current)) return current;
          if (budgetChosen && current === "") return "";
          return rows.find((b) => b.isDefault)?.id ?? "";
        });
        setBudgetsLoaded(true);
      });
    return () => {
      cancelled = true;
    };
    // budgetChosen is read once per year change on purpose.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [budgetYearId]);

  useEffect(() => {
    if (!budgetsLoaded) return;
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
        setError(apiErrorMessage(err, err.message));
      })
      .finally(() => {
        if (!cancelled) setPending(false);
      });
    return () => {
      cancelled = true;
    };
  }, [queryString, budgetsLoaded]);

  useEffect(() => {
    router.replace(`${pathname}?${urlQueryString}`, { scroll: false });
  }, [urlQueryString, pathname, router]);

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
        {budgets.length > 0 && (
          <FormRow>
            <Field label="Budget" htmlFor="incomeBudget">
              <Select
                id="incomeBudget"
                value={budgetId}
                disabled={budgetBlocked}
                onChange={(e) => {
                  setBudgetChosen(true);
                  setBudgetId(e.target.value);
                }}
              >
                <option value="">Ingen</option>
                {budgets.map((b) => (
                  <option key={b.id} value={b.id}>
                    {b.name}
                    {b.isDefault ? " (förvald)" : ""}
                  </option>
                ))}
              </Select>
            </Field>
            {budgetBlocked && (
              <FormHint>Budget kan inte kombineras med Projekt eller Per kostnadsställe/Per projekt.</FormHint>
            )}
          </FormRow>
        )}
      </Card>

      {error && <FormError>{error}</FormError>}

      {report && !pending && columns && <ObjectMatrix report={report} columns={columns} from={from} to={to} />}

      {report && !pending && !columns && report.budget && <BudgetStatement report={report} from={from} to={to} />}

      {report && !pending && !columns && !report.budget && (
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
                    return row.accountId ? (
                      <Link href={`/ekonomi/huvudbok?accountId=${row.accountId}&from=${from}&to=${to}`}>
                        {row.accountNumber}
                      </Link>
                    ) : (
                      row.accountNumber
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
                  <tr key={`a-${entry.key}-${a.accountNumber}`} className={styles.accountRow}>
                    <td className={styles.labelCell}>
                      {a.accountId ? (
                        <Link href={`/ekonomi/huvudbok?accountId=${a.accountId}&from=${from}&to=${to}`}>{a.accountNumber}</Link>
                      ) : (
                        a.accountNumber
                      )}{" "}
                      {a.accountName}
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

type BudgetRow =
  | ({ id: string; kind: "line" | "subtotal"; label: string; actual: number } & Partial<BudgetFigures>)
  | ({
      id: string;
      kind: "account";
      accountId: string | null;
      accountNumber: string;
      accountName: string;
      actual: number;
    } & Partial<BudgetFigures>);

function flattenBudget(report: IncomeStatementResponse): BudgetRow[] {
  const rows: BudgetRow[] = [];
  for (const entry of report.entries) {
    if (entry.kind === "subtotal") {
      rows.push({ ...entry, id: `s-${entry.key}`, kind: "subtotal", actual: entry.total });
      continue;
    }
    const { accounts, ...figures } = entry;
    rows.push({ ...figures, id: `l-${entry.key}`, kind: "line", actual: entry.total });
    for (const account of accounts) {
      rows.push({
        ...account,
        id: `a-${entry.key}-${account.accountNumber}`,
        kind: "account",
        accountId: account.accountId,
        accountNumber: account.accountNumber,
        accountName: account.accountName,
        actual: account.amount,
      });
    }
  }
  return rows;
}

// With a budget: Utfall, Budget, Avvikelse and Avvikelse % for the period, and
// the same accumulated from the start of the fiscal year when the period does
// not begin there. A negative variance is marked with the stopped colour.
function BudgetStatement({ report, from, to }: { report: IncomeStatementResponse; from: string; to: string }) {
  const showAccumulated = report.accumulatedFrom !== undefined && from !== report.accumulatedFrom;
  const rows = flattenBudget(report);
  const money = (n: number | undefined) => formatMoney(n ?? 0);
  const percent = (n: number | null | undefined) => (n === null || n === undefined ? "–" : formatPercent(n, 1));
  const variance = (n: number | undefined, text: string) => (
    <span className={`${styles.amountCell} num ${(n ?? 0) < 0 ? styles.negative : ""}`}>{text}</span>
  );
  return (
    <Card maxWidth="none">
      <p className={styles.budgetNote}>
        Budget: {report.budget?.name}. Avvikelse = utfall − budget; ett negativt tal är sämre än budget.
      </p>
      <div className={styles.scroller}>
        <table className={styles.matrix}>
          <thead>
            <tr>
              <th className={styles.labelCell}>Konto / benämning</th>
              <th className={styles.amountCell}>Utfall</th>
              <th className={styles.amountCell}>Budget</th>
              <th className={styles.amountCell}>Avvikelse</th>
              <th className={styles.amountCell}>Avvikelse %</th>
              {showAccumulated && (
                <>
                  <th className={`${styles.amountCell} ${styles.sumCell}`}>Utfall ack.</th>
                  <th className={styles.amountCell}>Budget ack.</th>
                  <th className={styles.amountCell}>Avvikelse ack.</th>
                  <th className={styles.amountCell}>Avvikelse ack. %</th>
                </>
              )}
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr
                key={row.id}
                className={row.kind === "subtotal" ? styles.subtotalRow : row.kind === "line" ? styles.lineRow : styles.accountRow}
              >
                <td className={styles.labelCell}>
                  {row.kind === "account" ? (
                    <>
                      {row.accountId ? (
                        <Link href={`/ekonomi/huvudbok?accountId=${row.accountId}&from=${from}&to=${to}`}>{row.accountNumber}</Link>
                      ) : (
                        row.accountNumber
                      )}{" "}
                      {row.accountName}
                    </>
                  ) : (
                    row.label
                  )}
                </td>
                <td className={`${styles.amountCell} num`}>{money(row.actual)}</td>
                <td className={`${styles.amountCell} num`}>{money(row.budget)}</td>
                <td className={styles.amountCell}>{variance(row.variance, money(row.variance))}</td>
                <td className={styles.amountCell}>{variance(row.variance, percent(row.variancePercent))}</td>
                {showAccumulated && (
                  <>
                    <td className={`${styles.amountCell} ${styles.sumCell} num`}>{money(row.accumulated)}</td>
                    <td className={`${styles.amountCell} num`}>{money(row.accumulatedBudget)}</td>
                    <td className={styles.amountCell}>{variance(row.accumulatedVariance, money(row.accumulatedVariance))}</td>
                    <td className={styles.amountCell}>
                      {variance(row.accumulatedVariance, percent(row.accumulatedVariancePercent))}
                    </td>
                  </>
                )}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </Card>
  );
}

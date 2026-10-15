"use client";

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { Card } from "../ui/Card";
import { Field, Input } from "../ui/Field";
import { FormError, FormRow } from "../ui/Form";
import { Table } from "../ui/Table";
import { API_URL, apiFetch } from "../../lib/api";
import { formatMoney } from "../../lib/format";
import buttonStyles from "../ui/Button.module.css";
import type { FiscalYear, IncomeStatementResponse } from "../../lib/types";

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
}: {
  fiscalYears: FiscalYear[];
  defaultFrom?: string;
  defaultTo?: string;
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
  const [report, setReport] = useState<IncomeStatementResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setPending(true);
    setError(null);
    apiFetch<IncomeStatementResponse>(`/api/v1/income-statement?from=${from}&to=${to}`)
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
  }, [from, to]);

  useEffect(() => {
    router.replace(`${pathname}?from=${from}&to=${to}`, { scroll: false });
  }, [from, to, pathname, router]);

  const rows = report ? flatten(report) : [];

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
              href={`${API_URL}/api/v1/income-statement/pdf?from=${from}&to=${to}`}
              download
              className={`${buttonStyles.button} ${buttonStyles.ghost}`}
            >
              Ladda ner PDF
            </a>
          )}
          {report && (
            <a
              href={`${API_URL}/api/v1/income-statement/csv?from=${from}&to=${to}`}
              download
              className={`${buttonStyles.button} ${buttonStyles.ghost}`}
            >
              Ladda ner CSV
            </a>
          )}
        </FormRow>
      </Card>

      {error && <FormError>{error}</FormError>}

      {report && !pending && (
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

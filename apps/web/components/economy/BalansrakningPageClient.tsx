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
import type { BalanceSheetResponse, FiscalYear } from "../../lib/types";

// One flat row per printed line — the same discriminated-row technique the
// momsrapport uses, except the labels come from the API because the lines are
// data-driven from the BAS interval table.
type SheetRow =
  | { id: string; kind: "section"; label: string; total: number }
  | { id: string; kind: "group"; label: string; total: number }
  | { id: string; kind: "line"; label: string; total: number }
  | {
      id: string;
      kind: "account";
      accountId: string;
      accountNumber: string;
      accountName: string;
      amount: number;
    };

function flatten(report: BalanceSheetResponse): SheetRow[] {
  const rows: SheetRow[] = [];
  const sections = [
    { key: "assets", label: "TILLGÅNGAR", body: report.assets },
    { key: "eq", label: "EGET KAPITAL OCH SKULDER", body: report.equityAndLiabilities },
  ] as const;

  for (const section of sections) {
    for (const group of section.body.groups) {
      rows.push({ id: `${section.key}-g-${group.key}`, kind: "group", label: group.label, total: group.total });
      for (const line of group.lines) {
        rows.push({ id: `${section.key}-l-${line.key}`, kind: "line", label: line.label, total: line.total });
        for (const account of line.accounts) {
          rows.push({
            id: `${section.key}-a-${account.accountId}`,
            kind: "account",
            accountId: account.accountId,
            accountNumber: account.accountNumber,
            accountName: account.accountName,
            amount: account.amount,
          });
        }
      }
    }
    rows.push({
      id: `${section.key}-total`,
      kind: "section",
      label: `Summa ${section.label.toLowerCase()}`,
      total: section.body.total,
    });
  }
  return rows;
}

export function BalansrakningPageClient({
  fiscalYears,
  defaultAsOf,
}: {
  fiscalYears: FiscalYear[];
  defaultAsOf?: string;
}) {
  const router = useRouter();
  const pathname = usePathname();

  // The API derives the fiscal year from the date, so the date is the only
  // control. Default to the latest fiscal year's end, falling back to today.
  const initialAsOf = useMemo(
    () => defaultAsOf ?? fiscalYears[0]?.endDate ?? new Date().toLocaleDateString("sv-SE"),
    [defaultAsOf, fiscalYears]
  );
  const [asOf, setAsOf] = useState(initialAsOf);
  const [report, setReport] = useState<BalanceSheetResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setPending(true);
    setError(null);
    apiFetch<BalanceSheetResponse>(`/api/v1/balance-sheet?asOf=${asOf}`)
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
  }, [asOf]);

  useEffect(() => {
    router.replace(`${pathname}?asOf=${asOf}`, { scroll: false });
  }, [asOf, pathname, router]);

  const rows = report ? flatten(report) : [];
  const yearStart = report?.fiscalYear.startDate;

  return (
    <>
      <Card>
        <FormRow>
          <Field label="Per datum">
            <Input type="date" size="sm" value={asOf} onChange={(e) => setAsOf(e.target.value)} />
          </Field>
          {report && (
            <a
              href={`${API_URL}/api/v1/balance-sheet/pdf?asOf=${asOf}`}
              download
              className={`${buttonStyles.button} ${buttonStyles.ghost}`}
            >
              Ladda ner PDF
            </a>
          )}
          {report && (
            <a
              href={`${API_URL}/api/v1/balance-sheet/csv?asOf=${asOf}`}
              download
              className={`${buttonStyles.button} ${buttonStyles.ghost}`}
            >
              Ladda ner CSV
            </a>
          )}
        </FormRow>
        {report && (
          <p style={{ color: "var(--color-text-muted)", margin: 0 }}>Räkenskapsår {report.fiscalYear.label}</p>
        )}
      </Card>

      {error && <FormError>{error}</FormError>}

      {report && report.difference !== 0 && (
        <FormError>
          Balansräkningen balanserar inte (differens {formatMoney(report.difference)}) — kontrollera om något
          verifikat är obalanserat.
        </FormError>
      )}

      {report && !pending && (
        <Card>
          <Table<SheetRow>
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
                      <Link
                        href={`/ekonomi/huvudbok?accountId=${row.accountId}&from=${yearStart}&to=${asOf}`}
                      >
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
                  return row.kind === "line" ? (
                    <span style={{ paddingLeft: 8, fontWeight: 500 }}>{row.label}</span>
                  ) : (
                    <strong>{row.label}</strong>
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

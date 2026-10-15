"use client";

import { useEffect, useState } from "react";
import { usePathname, useRouter } from "next/navigation";
import { KpiRow, KpiTile } from "../dashboard/KpiTile";
import { Card } from "../ui/Card";
import { Field, Select } from "../ui/Field";
import { FormError, FormHint } from "../ui/Form";
import { Table } from "../ui/Table";
import { apiFetch } from "../../lib/api";
import { formatMoney } from "../../lib/format";
import type { StatisticsRow } from "../../lib/types";
import { FillBar } from "./FillBar";
import { MonthRangeFields } from "./MonthRangeFields";
import { ReportCsvLink } from "./ReportCsvLink";

type GroupBy = "month" | "customer" | "supplier" | "article";

interface StatisticsResponse {
  from: string;
  to: string;
  groupBy: string;
  rows: StatisticsRow[];
  totalNet: number;
  basis?: "header" | "rows";
}

type StatisticsRowWithId = StatisticsRow & { id: string };

// Shared body for Försäljningsstatistik and Inköpsstatistik — the two
// endpoints answer the identical shape (purchase adds `basis`), and their
// "Gruppera per" options only differ in the entity dimension (customer vs
// supplier), so one client covers both.
export function StatisticsPageClient({
  kind,
  endpoint,
  entityLabel,
  defaultFrom,
  defaultTo,
  defaultGroupBy,
}: {
  kind: "sales" | "purchase";
  endpoint: string;
  entityLabel: string;
  defaultFrom: string | undefined;
  defaultTo: string | undefined;
  defaultGroupBy: string | undefined;
}) {
  const router = useRouter();
  const pathname = usePathname();

  const [from, setFrom] = useState(defaultFrom ?? "");
  const [to, setTo] = useState(defaultTo ?? "");
  const [groupBy, setGroupBy] = useState<GroupBy>(
    defaultGroupBy === "customer" || defaultGroupBy === "supplier" || defaultGroupBy === "article"
      ? defaultGroupBy
      : "month"
  );
  const [data, setData] = useState<StatisticsResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const qs = new URLSearchParams({ groupBy });
    if (from) qs.set("from", from);
    if (to) qs.set("to", to);
    const qsString = qs.toString();
    router.replace(`${pathname}?${qsString}`, { scroll: false });

    let cancelled = false;
    setLoading(true);
    setError(null);
    apiFetch<StatisticsResponse>(`${endpoint}?${qsString}`)
      .then((res) => {
        if (!cancelled) setData(res);
      })
      .catch((err: Error) => {
        if (cancelled) return;
        setData(null);
        setError(err.message);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- router/pathname are stable
  }, [from, to, groupBy]);

  const labelHeader = groupBy === "month" ? "Månad" : groupBy === "article" ? "Artikel" : entityLabel;
  const showQuantity = groupBy === "article";
  const maxNet = data ? Math.max(1, ...data.rows.map((r) => Math.abs(r.netAmount))) : 1;
  const rows: StatisticsRowWithId[] = data ? data.rows.map((r) => ({ ...r, id: r.key })) : [];

  const columns = [
    { key: "label", label: labelHeader, width: "1.6fr" },
    { key: "netAmount", label: "Nettobelopp", width: "220px", align: "right" as const },
    ...(showQuantity ? [{ key: "quantity", label: "Antal", width: "100px", align: "right" as const }] : []),
    { key: "invoiceCount", label: "Antal fakturor", width: "130px", align: "right" as const },
  ];

  const csvQs = new URLSearchParams({ groupBy });
  if (data) {
    csvQs.set("from", data.from);
    csvQs.set("to", data.to);
  }

  return (
    <>
      <Card maxWidth="none" style={{ marginBottom: 20 }}>
        <MonthRangeFields from={from} to={to} onFromChange={setFrom} onToChange={setTo} resolved={data} columns={3}>
          <Field label="Gruppera per" htmlFor="groupBy">
            <Select id="groupBy" value={groupBy} onChange={(e) => setGroupBy(e.target.value as GroupBy)}>
              <option value="month">Månad</option>
              <option value={kind === "sales" ? "customer" : "supplier"}>{entityLabel}</option>
              <option value="article">Artikel</option>
            </Select>
          </Field>
        </MonthRangeFields>
      </Card>

      <FormError margin="below">{error}</FormError>
      {loading && <FormHint>Hämtar statistiken…</FormHint>}

      {data && !loading && (
        <>
          <KpiRow>
            <KpiTile label="Nettobelopp totalt" value={`${formatMoney(data.totalNet)} kr`} />
          </KpiRow>

          {kind === "purchase" && groupBy === "article" && data.basis === "rows" && (
            <FormHint>
              Artikeluppdelningen summerar radbelopp och kan avvika från fakturornas huvudbelopp.
            </FormHint>
          )}

          <Card maxWidth="none" style={{ margin: "16px 0" }}>
            <div style={{ display: "flex", justifyContent: "flex-end", marginBottom: 12 }}>
              <ReportCsvLink path={`${endpoint}/csv?${csvQs.toString()}`} />
            </div>
            <Table<StatisticsRowWithId>
              columns={columns}
              rows={rows}
              emptyText="Inga rader i perioden."
              renderCell={(row, key) => {
                switch (key) {
                  case "label":
                    return row.label;
                  case "netAmount":
                    return (
                      <div>
                        <span className="num">{formatMoney(row.netAmount)}</span>
                        <FillBar percent={(Math.abs(row.netAmount) / maxNet) * 100} />
                      </div>
                    );
                  case "quantity":
                    return <span className="num">{row.quantity !== null ? row.quantity.toLocaleString("sv-SE") : "—"}</span>;
                  case "invoiceCount":
                    return <span className="num">{row.invoiceCount}</span>;
                  default:
                    return null;
                }
              }}
            />
          </Card>
        </>
      )}
    </>
  );
}

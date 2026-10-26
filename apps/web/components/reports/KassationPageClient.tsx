"use client";

import { useEffect, useState } from "react";
import { usePathname, useRouter } from "next/navigation";
import { Card } from "../ui/Card";
import { Field, Select } from "../ui/Field";
import { FormError, FormHint } from "../ui/Form";
import { Table } from "../ui/Table";
import { apiFetch } from "../../lib/api";
import type { ScrapStatisticsResponse } from "../../lib/types";
import { MonthRangeFields } from "./MonthRangeFields";
import { ReportCsvLink } from "./ReportCsvLink";

type GroupBy = "month" | "article" | "workCenter" | "reason";

type ScrapRowWithId = ScrapStatisticsResponse["rows"][number] & { id: string };

const GROUP_LABELS: Record<GroupBy, string> = {
  month: "Månad",
  article: "Artikel",
  workCenter: "Resurs",
  reason: "Orsak",
};

export function KassationPageClient({
  defaultFrom,
  defaultTo,
  defaultGroupBy,
}: {
  defaultFrom: string | undefined;
  defaultTo: string | undefined;
  defaultGroupBy: string | undefined;
}) {
  const router = useRouter();
  const pathname = usePathname();

  const [from, setFrom] = useState(defaultFrom ?? "");
  const [to, setTo] = useState(defaultTo ?? "");
  const [groupBy, setGroupBy] = useState<GroupBy>(
    defaultGroupBy === "article" || defaultGroupBy === "workCenter" || defaultGroupBy === "reason"
      ? defaultGroupBy
      : "month"
  );
  const [data, setData] = useState<ScrapStatisticsResponse | null>(null);
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
    apiFetch<ScrapStatisticsResponse>(`/api/v1/reports/scrap-statistics?${qsString}`)
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

  const rows: ScrapRowWithId[] = data ? data.rows.map((r) => ({ ...r, id: r.key })) : [];
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
              <option value="article">Artikel</option>
              <option value="workCenter">Resurs</option>
              <option value="reason">Orsak</option>
            </Select>
          </Field>
        </MonthRangeFields>
      </Card>

      <FormError margin="below">{error}</FormError>
      {loading && <FormHint>Hämtar kassationsstatistiken…</FormHint>}

      {data && !loading && (
        <>
          <Card maxWidth="none" style={{ margin: "16px 0" }}>
            <div style={{ display: "flex", justifyContent: "flex-end", marginBottom: 12 }}>
              <ReportCsvLink path={`/api/v1/reports/scrap-statistics/csv?${csvQs.toString()}`} />
            </div>
            <Table<ScrapRowWithId>
              columns={[
                { key: "label", label: GROUP_LABELS[groupBy], width: "1.6fr" },
                { key: "scrappedQuantity", label: "Antal kasserade", width: "160px", align: "right" },
                { key: "reportCount", label: "Antal rapporter", width: "160px", align: "right" },
              ]}
              rows={rows}
              emptyText="Inga kassationer i perioden."
              renderCell={(row, key) => {
                switch (key) {
                  case "label":
                    return row.label;
                  case "scrappedQuantity":
                    return <span className="num">{row.scrappedQuantity.toLocaleString("sv-SE")}</span>;
                  case "reportCount":
                    return <span className="num">{row.reportCount}</span>;
                  default:
                    return null;
                }
              }}
              footer={{
                label: <strong>Totalt</strong>,
                scrappedQuantity: <span className="num">{data.totalScrapped.toLocaleString("sv-SE")}</span>,
              }}
            />
          </Card>

          {groupBy === "reason" && (
            <FormHint>
              Orsaken är det som valts ur Kvalitetsorsaker vid avrapporteringen. Äldre kassationer som rapporterats med
              fritext grupperas på exakt text och märks (fritext).
            </FormHint>
          )}
        </>
      )}
    </>
  );
}

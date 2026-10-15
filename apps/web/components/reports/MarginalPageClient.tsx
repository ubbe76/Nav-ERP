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
import type { OrderMarginResponse, MarginGroup } from "../../lib/types";
import { MonthRangeFields } from "./MonthRangeFields";
import { ReportCsvLink } from "./ReportCsvLink";
import deviationStyles from "./Deviation.module.css";

type GroupBy = "month" | "customer" | "article";
type MarginGroupWithId = MarginGroup & { id: string };

const ENDPOINT = "/api/v1/reports/order-margin";

function percent(value: number | null) {
  if (value === null) return <span className="num">—</span>;
  const tone = value < 0 ? deviationStyles.over : undefined;
  return <span className={`num ${tone ?? ""}`}>{value.toLocaleString("sv-SE", { maximumFractionDigits: 1 })} %</span>;
}

// null is not 0: a group whose rows have no calculation has an UNKNOWN margin,
// and a dash says so where a zero would quietly claim it broke even.
function money(value: number | null) {
  return value === null ? <span className="num">—</span> : <span className="num">{formatMoney(value)}</span>;
}

export function MarginalPageClient({
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
    defaultGroupBy === "customer" || defaultGroupBy === "article" ? defaultGroupBy : "month"
  );
  const [data, setData] = useState<OrderMarginResponse | null>(null);
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
    apiFetch<OrderMarginResponse>(`${ENDPOINT}?${qsString}`)
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

  const labelHeader = groupBy === "month" ? "Månad" : groupBy === "article" ? "Artikel" : "Kund";
  const rows: MarginGroupWithId[] = data ? data.groups.map((g) => ({ ...g, id: g.key })) : [];

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
              <option value="customer">Kund</option>
              <option value="article">Artikel</option>
            </Select>
          </Field>
        </MonthRangeFields>
      </Card>

      <FormError margin="below">{error}</FormError>
      {loading && <FormHint>Hämtar marginalen…</FormHint>}

      {data && !loading && (
        <>
          <KpiRow>
            <KpiTile label="Nettoomsättning" value={`${formatMoney(data.total.netRevenue)} kr`} />
            <KpiTile
              label="Täckningsbidrag"
              value={data.total.contribution === null ? "—" : `${formatMoney(data.total.contribution)} kr`}
            />
            <KpiTile
              label="Täckningsgrad"
              value={
                data.total.marginPercent === null
                  ? "—"
                  : `${data.total.marginPercent.toLocaleString("sv-SE", { maximumFractionDigits: 1 })} %`
              }
            />
            <KpiTile label="Rader utan kalkyl" value={String(data.total.rowsWithoutCost)} />
          </KpiRow>

          <FormHint>
            Självkostnaden är artikelns <strong>senaste sparade förkalkyl</strong> — alltså dagens kostnadsläge
            tillämpat på historisk omsättning, inte vad marginalen var då. Fakturarader vars artikel saknar förkalkyl
            räknas med i omsättningen men inte i täckningsbidraget; kolumnen <strong>Utan kalkyl</strong> visar hur
            många de är.
          </FormHint>

          <Card maxWidth="none" style={{ margin: "16px 0" }}>
            <div style={{ display: "flex", justifyContent: "flex-end", marginBottom: 12 }}>
              <ReportCsvLink path={`${ENDPOINT}/csv?${csvQs.toString()}`} />
            </div>
            <Table<MarginGroupWithId>
              columns={[
                { key: "label", label: labelHeader, width: "1.6fr" },
                { key: "netRevenue", label: "Nettoomsättning", width: "160px", align: "right" },
                { key: "cost", label: "Självkostnad", width: "140px", align: "right" },
                { key: "contribution", label: "TB", width: "140px", align: "right" },
                { key: "marginPercent", label: "TG", width: "90px", align: "right" },
                { key: "rowsWithoutCost", label: "Utan kalkyl", width: "110px", align: "right" },
              ]}
              rows={rows}
              emptyText="Inga fakturerade rader i perioden."
              footer={{
                label: "Totalt",
                netRevenue: formatMoney(data.total.netRevenue),
                cost: data.total.cost === null ? "—" : formatMoney(data.total.cost),
                contribution: data.total.contribution === null ? "—" : formatMoney(data.total.contribution),
                marginPercent:
                  data.total.marginPercent === null
                    ? "—"
                    : `${data.total.marginPercent.toLocaleString("sv-SE", { maximumFractionDigits: 1 })} %`,
                rowsWithoutCost: String(data.total.rowsWithoutCost),
              }}
              renderCell={(row, key) => {
                switch (key) {
                  case "label":
                    return row.label;
                  case "netRevenue":
                    return <span className="num">{formatMoney(row.netRevenue)}</span>;
                  case "cost":
                    return money(row.cost);
                  case "contribution":
                    return money(row.contribution);
                  case "marginPercent":
                    return percent(row.marginPercent);
                  case "rowsWithoutCost":
                    return <span className="num">{row.rowsWithoutCost}</span>;
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

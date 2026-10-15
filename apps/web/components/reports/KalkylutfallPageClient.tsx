"use client";

import { useEffect, useState } from "react";
import { GatedLink } from "../ui/GatedLink";
import { usePathname, useRouter } from "next/navigation";
import { KpiRow, KpiTile } from "../dashboard/KpiTile";
import { Card } from "../ui/Card";
import { FormError, FormHint } from "../ui/Form";
import { Table } from "../ui/Table";
import { apiFetch } from "../../lib/api";
import { formatMoney } from "../../lib/format";
import type { CalculationOutcomeResponse, OutcomeRow } from "../../lib/types";
import deviationStyles from "./Deviation.module.css";
import { MonthRangeFields } from "./MonthRangeFields";
import { ReportCsvLink } from "./ReportCsvLink";
import { formatSignedPercent } from "./reportFormat";

type OutcomeRowWithId = OutcomeRow & { id: string };

function DeviationCell({ deltaPct }: { deltaPct: number | null }) {
  if (deltaPct === null) return <span className="num">—</span>;
  const tone = deltaPct > 0 ? deviationStyles.over : deltaPct < 0 ? deviationStyles.under : undefined;
  return <span className={`num ${tone ?? ""}`}>{formatSignedPercent(deltaPct)}</span>;
}

export function KalkylutfallPageClient({
  defaultFrom,
  defaultTo,
}: {
  defaultFrom: string | undefined;
  defaultTo: string | undefined;
}) {
  const router = useRouter();
  const pathname = usePathname();

  const [from, setFrom] = useState(defaultFrom ?? "");
  const [to, setTo] = useState(defaultTo ?? "");
  const [data, setData] = useState<CalculationOutcomeResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const qs = new URLSearchParams();
    if (from) qs.set("from", from);
    if (to) qs.set("to", to);
    const qsString = qs.toString();
    router.replace(qsString ? `${pathname}?${qsString}` : pathname, { scroll: false });

    let cancelled = false;
    setLoading(true);
    setError(null);
    apiFetch<CalculationOutcomeResponse>(`/api/v1/reports/calculation-outcome?${qsString}`)
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
  }, [from, to]);

  const rows: OutcomeRowWithId[] = data ? data.rows.map((r) => ({ ...r, id: r.manufacturingOrderId })) : [];
  const csvQs = new URLSearchParams();
  if (data) {
    csvQs.set("from", data.from);
    csvQs.set("to", data.to);
  }

  return (
    <>
      <Card maxWidth="none" style={{ marginBottom: 20 }}>
        <MonthRangeFields from={from} to={to} onFromChange={setFrom} onToChange={setTo} resolved={data} />
      </Card>

      <FormError margin="below">{error}</FormError>
      {loading && <FormHint>Hämtar kalkylutfallet…</FormHint>}

      {data && !loading && (
        <>
          <KpiRow>
            <KpiTile label="Antal jämförda" value={data.summary.count} unit={data.summary.count === 1 ? "TO" : "TO:n"} />
            <KpiTile
              label="Snittavvikelse %"
              value={data.summary.avgDeviationPct !== null ? formatSignedPercent(data.summary.avgDeviationPct) : "—"}
            />
          </KpiRow>

          <Card maxWidth="none" style={{ margin: "16px 0" }}>
            <div style={{ display: "flex", justifyContent: "flex-end", marginBottom: 12 }}>
              <ReportCsvLink path={`/api/v1/reports/calculation-outcome/csv?${csvQs.toString()}`} />
            </div>
            <Table<OutcomeRowWithId>
              columns={[
                { key: "orderNumber", label: "TO", width: "110px" },
                { key: "article", label: "Artikel", width: "1.6fr" },
                { key: "quantity", label: "Antal", width: "90px", align: "right" },
                { key: "preTvk", label: "Förkalkyl TVK/st", width: "150px", align: "right" },
                { key: "postTvk", label: "Efterkalkyl TVK/st", width: "150px", align: "right" },
                { key: "delta", label: "Avvikelse/st", width: "130px", align: "right" },
                { key: "deltaPct", label: "Avvikelse %", width: "120px", align: "right" },
              ]}
              rows={rows}
              emptyText="Inga jämförbara tillverkningsordrar i perioden."
              renderCell={(row, key) => {
                switch (key) {
                  case "orderNumber":
                    return <GatedLink href={`/tillverkning/ordrar/${row.manufacturingOrderId}`}>{row.orderNumber}</GatedLink>;
                  case "article":
                    return (
                      <>
                        {row.articleNumber} — {row.articleName}
                        {row.preMultiLevel && <span className={deviationStyles.tag}>flernivå</span>}
                      </>
                    );
                  case "quantity":
                    return <span className="num">{row.quantity.toLocaleString("sv-SE")}</span>;
                  case "preTvk":
                    return <span className="num">{formatMoney(row.preTvkPerUnit)}</span>;
                  case "postTvk":
                    return <span className="num">{formatMoney(row.postTvkPerUnit)}</span>;
                  case "delta":
                    return <span className="num">{formatMoney(row.deltaPerUnit)}</span>;
                  case "deltaPct":
                    return <DeviationCell deltaPct={row.deltaPct} />;
                  default:
                    return null;
                }
              }}
            />
          </Card>

          <FormHint>
            Ej jämförbara: {data.notComparable.onlyPre} med endast förkalkyl, {data.notComparable.onlyPost} med
            endast efterkalkyl, {data.notComparable.invalidQuantity} med ogiltigt antal.
          </FormHint>
        </>
      )}
    </>
  );
}

"use client";

import { useEffect, useState, type ReactNode } from "react";
import { usePathname, useRouter } from "next/navigation";
import { KpiRow, KpiTile } from "../dashboard/KpiTile";
import { Card } from "../ui/Card";
import { FormError, FormHint } from "../ui/Form";
import { Table } from "../ui/Table";
import { apiFetch } from "../../lib/api";
import { formatPercent } from "../../lib/format";
import type { DeliveryPrecisionResponse, PrecisionMonth, PrecisionSection } from "../../lib/types";
import { FillBar } from "./FillBar";
import { MonthRangeFields } from "./MonthRangeFields";
import { ReportCsvLink } from "./ReportCsvLink";
import { monthLabel } from "./reportFormat";

type PrecisionRow = PrecisionMonth & { id: string };

function daysText(value: number | null): string {
  return value !== null ? value.toLocaleString("sv-SE", { maximumFractionDigits: 1 }) : "—";
}

// The Precision cell/footer both need the same "number + fill bar" body —
// shared so the totals row can't drift from the per-month rows.
function precisionCell(precisionPct: number | null): ReactNode {
  if (precisionPct === null) return <span className="num">—</span>;
  return (
    <div>
      <span className="num">{formatPercent(precisionPct)}</span>
      <FillBar percent={precisionPct} />
    </div>
  );
}

function PrecisionTable({ title, section, csvPath }: { title: string; section: PrecisionSection; csvPath: string }) {
  const rows: PrecisionRow[] = section.months.map((m) => ({ ...m, id: m.month }));

  return (
    <Card maxWidth="none" style={{ marginBottom: 20 }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 12 }}>
        <div style={{ fontWeight: 600, fontSize: 15 }}>{title}</div>
        <ReportCsvLink path={csvPath} />
      </div>
      <Table<PrecisionRow>
        columns={[
          { key: "month", label: "Månad", width: "1fr" },
          { key: "total", label: "Antal", width: "90px", align: "right" },
          { key: "onTime", label: "I tid", width: "90px", align: "right" },
          { key: "late", label: "Försenade", width: "100px", align: "right" },
          { key: "precision", label: "Precision", width: "170px", align: "right" },
          { key: "avgDaysLate", label: "Snitt försening", width: "130px", align: "right" },
        ]}
        rows={rows}
        emptyText="Inga mätbara ordrar i perioden."
        renderCell={(row, key) => {
          switch (key) {
            case "month":
              return monthLabel(row.month);
            case "total":
              return <span className="num">{row.total}</span>;
            case "onTime":
              return <span className="num">{row.onTime}</span>;
            case "late":
              return <span className="num">{row.late}</span>;
            case "precision":
              return precisionCell(row.precisionPct);
            case "avgDaysLate":
              return <span className="num">{daysText(row.avgDaysLate)}</span>;
            default:
              return null;
          }
        }}
        footer={{
          month: <strong>Totalt</strong>,
          total: <span className="num">{section.totals.total}</span>,
          onTime: <span className="num">{section.totals.onTime}</span>,
          late: <span className="num">{section.totals.late}</span>,
          precision: precisionCell(section.totals.precisionPct),
          avgDaysLate: <span className="num">{daysText(section.totals.avgDaysLate)}</span>,
        }}
      />
      <FormHint>
        Ej mätbara: {section.notMeasurable.missingExpectedDate} utan förväntat leveransdatum,{" "}
        {section.notMeasurable.noDeliveryRecords} utan leveransdatum registrerat.
      </FormHint>
    </Card>
  );
}

export function LeveransprecisionPageClient({
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
  const [data, setData] = useState<DeliveryPrecisionResponse | null>(null);
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
    apiFetch<DeliveryPrecisionResponse>(`/api/v1/reports/delivery-precision?${qsString}`)
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

  const rangeQs = new URLSearchParams();
  if (data) {
    rangeQs.set("from", data.from);
    rangeQs.set("to", data.to);
  }

  return (
    <>
      <Card maxWidth="none" style={{ marginBottom: 20 }}>
        <MonthRangeFields
          from={from}
          to={to}
          onFromChange={setFrom}
          onToChange={setTo}
          resolved={data}
        />
      </Card>

      <FormError margin="below">{error}</FormError>
      {loading && <FormHint>Hämtar leveransprecision…</FormHint>}

      {data && !loading && (
        <>
          <KpiRow>
            <KpiTile
              label="Precision kundordrar %"
              value={data.sales.totals.precisionPct !== null ? formatPercent(data.sales.totals.precisionPct) : "—"}
            />
            <KpiTile
              label="Precision inköpsordrar %"
              value={
                data.purchase.totals.precisionPct !== null ? formatPercent(data.purchase.totals.precisionPct) : "—"
              }
            />
            <KpiTile
              label="Snitt försening kundordrar"
              value={daysText(data.sales.totals.avgDaysLate)}
              unit="dagar"
            />
            <KpiTile
              label="Snitt försening inköpsordrar"
              value={daysText(data.purchase.totals.avgDaysLate)}
              unit="dagar"
            />
          </KpiRow>

          <PrecisionTable
            title="Kundordrar"
            section={data.sales}
            csvPath={`/api/v1/reports/delivery-precision/csv?kind=sales&${rangeQs.toString()}`}
          />
          <PrecisionTable
            title="Inköpsordrar"
            section={data.purchase}
            csvPath={`/api/v1/reports/delivery-precision/csv?kind=purchase&${rangeQs.toString()}`}
          />
        </>
      )}
    </>
  );
}

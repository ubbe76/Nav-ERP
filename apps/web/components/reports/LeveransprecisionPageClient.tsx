"use client";

import { useEffect, useState, type ReactNode } from "react";
import { usePathname, useRouter } from "next/navigation";
import { KpiRow, KpiTile } from "../dashboard/KpiTile";
import { Card } from "../ui/Card";
import { Field, Select } from "../ui/Field";
import { FormError, FormHint } from "../ui/Form";
import { Table } from "../ui/Table";
import { apiFetch } from "../../lib/api";
import { formatMoney, formatPercent } from "../../lib/format";
import type {
  DeliveryPrecisionResponse,
  PrecisionCounterparty,
  PrecisionCounterpartyFigures,
  PrecisionMonth,
  PrecisionSection,
} from "../../lib/types";
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

type GroupBy = "month" | "counterparty";

type CounterpartyRow = PrecisionCounterparty & { id: string };

// Reklamerat antal: the total when every claim is in one unit, otherwise "—"
// that opens into the quantities per article (units never add up).
function claimedCell(figures: PrecisionCounterpartyFigures): ReactNode {
  if (figures.claimedQuantity !== null) {
    return (
      <span className="num">
        {figures.claimedQuantity.toLocaleString("sv-SE", { maximumFractionDigits: 4 })} {figures.claimedUnit}
      </span>
    );
  }
  if (figures.claimedByArticle.length === 0) return <span className="num">—</span>;
  return (
    <details>
      <summary>
        <span className="num">—</span>
      </summary>
      <ul style={{ margin: "6px 0 0", paddingLeft: 18 }}>
        {figures.claimedByArticle.map((a) => (
          <li key={`${a.articleId}-${a.unitCode}`}>
            {a.articleNumber ?? "Utan artikel"} {a.articleName ?? ""}:{" "}
            <span className="num">
              {a.quantity.toLocaleString("sv-SE", { maximumFractionDigits: 4 })} {a.unitCode ?? ""}
            </span>
          </li>
        ))}
      </ul>
    </details>
  );
}

const percentText = (value: number | null) => (value === null ? "—" : formatPercent(value, 0));

// Gruppera Motpart: the precision columns plus the quality columns, per
// customer (Kundordrar) or supplier (Inköpsordrar).
function CounterpartyTable({
  title,
  label,
  section,
  csvPath,
}: {
  title: string;
  label: string;
  section: PrecisionSection;
  csvPath: string;
}) {
  const grouped = section.counterparties;
  const rows: CounterpartyRow[] = (grouped?.rows ?? []).map((r) => ({ ...r, id: r.counterpartyId }));
  const totals = grouped?.totals;
  // Avvikelsekostnad is only sent to users who may see prices.
  const showCost = totals?.deviationCost !== null && totals?.deviationCost !== undefined;

  return (
    <Card maxWidth="none" style={{ marginBottom: 20 }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 12 }}>
        <div style={{ fontWeight: 600, fontSize: 15 }}>{title}</div>
        <ReportCsvLink path={csvPath} />
      </div>
      <Table<CounterpartyRow>
        columns={[
          { key: "counterpartyName", label, width: "minmax(140px, 1fr)" },
          { key: "total", label: "Order", width: "60px", align: "right" },
          { key: "onTime", label: "I tid", width: "55px", align: "right" },
          { key: "late", label: "Sena", width: "55px", align: "right" },
          { key: "precision", label: "Precision", width: "110px", align: "right" },
          { key: "avgDaysLate", label: "Snittförsening", width: "100px", align: "right" },
          { key: "deviations", label: "Avvikelser", width: "80px", align: "right" },
          { key: "ordersWithDeviation", label: "Order med avvikelse", width: "100px", align: "right" },
          { key: "defectFreePct", label: "Andel felfria", width: "80px", align: "right" },
          { key: "claimed", label: "Reklamerat antal", width: "110px", align: "right" },
          ...(showCost ? [{ key: "deviationCost", label: "Avvikelsekostnad", width: "110px", align: "right" as const }] : []),
        ]}
        rows={rows}
        emptyText="Inga mätbara ordrar i perioden."
        renderCell={(row, key) => {
          switch (key) {
            case "counterpartyName":
              return row.counterpartyName;
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
            case "deviations":
              return <span className="num">{row.deviations}</span>;
            case "ordersWithDeviation":
              return <span className="num">{row.ordersWithDeviation}</span>;
            case "defectFreePct":
              return <span className="num">{percentText(row.defectFreePct)}</span>;
            case "claimed":
              return claimedCell(row);
            case "deviationCost":
              return <span className="num">{row.deviationCost === null ? "—" : formatMoney(row.deviationCost)}</span>;
            default:
              return null;
          }
        }}
        footer={
          totals
            ? {
                counterpartyName: <strong>Totalt</strong>,
                total: <span className="num">{totals.total}</span>,
                onTime: <span className="num">{totals.onTime}</span>,
                late: <span className="num">{totals.late}</span>,
                precision: precisionCell(totals.precisionPct),
                avgDaysLate: <span className="num">{daysText(totals.avgDaysLate)}</span>,
                deviations: <span className="num">{totals.deviations}</span>,
                ordersWithDeviation: <span className="num">{totals.ordersWithDeviation}</span>,
                defectFreePct: <span className="num">{percentText(totals.defectFreePct)}</span>,
                claimed: claimedCell(totals),
                ...(showCost ? { deviationCost: <span className="num">{formatMoney(totals.deviationCost ?? 0)}</span> } : {}),
              }
            : undefined
        }
      />
      <FormHint>
        Avvikelser räknas per rapporteringsdatum i perioden (makulerade ej med). Andel felfria är andelen av de mätta
        ordrarna som saknar kopplad avvikelse. Ej mätbara: {section.notMeasurable.missingExpectedDate} utan förväntat
        leveransdatum, {section.notMeasurable.noDeliveryRecords} utan leveransdatum registrerat.
      </FormHint>
    </Card>
  );
}

export function LeveransprecisionPageClient({
  defaultFrom,
  defaultTo,
  defaultGroupBy,
}: {
  defaultFrom: string | undefined;
  defaultTo: string | undefined;
  defaultGroupBy?: string | undefined;
}) {
  const router = useRouter();
  const pathname = usePathname();

  const [from, setFrom] = useState(defaultFrom ?? "");
  const [to, setTo] = useState(defaultTo ?? "");
  const [groupBy, setGroupBy] = useState<GroupBy>(defaultGroupBy === "counterparty" ? "counterparty" : "month");
  const [data, setData] = useState<DeliveryPrecisionResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const qs = new URLSearchParams();
    if (from) qs.set("from", from);
    if (to) qs.set("to", to);
    if (groupBy !== "month") qs.set("groupBy", groupBy);
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
  }, [from, to, groupBy]);

  const rangeQs = new URLSearchParams();
  if (data) {
    rangeQs.set("from", data.from);
    rangeQs.set("to", data.to);
    if (groupBy === "counterparty") rangeQs.set("groupBy", "counterparty");
  }
  const byCounterparty = groupBy === "counterparty" && data?.sales.counterparties !== undefined;

  return (
    <>
      <Card maxWidth="none" style={{ marginBottom: 20 }}>
        <MonthRangeFields
          from={from}
          to={to}
          onFromChange={setFrom}
          onToChange={setTo}
          resolved={data}
          columns={3}
        >
          <Field label="Gruppera" htmlFor="precisionGroupBy">
            <Select id="precisionGroupBy" value={groupBy} onChange={(e) => setGroupBy(e.target.value as GroupBy)}>
              <option value="month">Månad</option>
              <option value="counterparty">Motpart</option>
            </Select>
          </Field>
        </MonthRangeFields>
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

          {byCounterparty ? (
            <>
              <CounterpartyTable
                title="Kundordrar"
                label="Kund"
                section={data.sales}
                csvPath={`/api/v1/reports/delivery-precision/csv?kind=sales&${rangeQs.toString()}`}
              />
              <CounterpartyTable
                title="Inköpsordrar"
                label="Leverantör"
                section={data.purchase}
                csvPath={`/api/v1/reports/delivery-precision/csv?kind=purchase&${rangeQs.toString()}`}
              />
            </>
          ) : (
            <>
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
      )}
    </>
  );
}

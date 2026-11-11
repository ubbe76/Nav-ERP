"use client";

import { useEffect, useState } from "react";
import { GatedLink } from "../ui/GatedLink";
import { usePathname, useRouter } from "next/navigation";
import { KpiRow, KpiTile } from "../dashboard/KpiTile";
import { Card } from "../ui/Card";
import { Field, Select } from "../ui/Field";
import { FormError, FormHint } from "../ui/Form";
import { SegmentedToggle } from "../ui/SegmentedToggle";
import { Table, TableSkeleton } from "../ui/Table";
import { apiFetch } from "../../lib/api";
import { apiErrorMessage } from "../../lib/errorMessages";
import { formatMoney } from "../../lib/format";
import type {
  CalculationAnalysisResponse,
  CalculationOutcomeGrouping,
  CalculationOutcomeResponse,
  CalculationOutcomeView,
  OutcomeRow,
} from "../../lib/types";
import { KalkylutfallAnalysis } from "./KalkylutfallAnalysis";
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

const GROUPINGS: CalculationOutcomeGrouping[] = ["order", "article", "workCenter"];

export function KalkylutfallPageClient({
  defaultFrom,
  defaultTo,
  defaultView,
  defaultGroupBy,
}: {
  defaultFrom: string | undefined;
  defaultTo: string | undefined;
  defaultView: string | undefined;
  defaultGroupBy: string | undefined;
}) {
  const router = useRouter();
  const pathname = usePathname();

  const [from, setFrom] = useState(defaultFrom ?? "");
  const [to, setTo] = useState(defaultTo ?? "");
  const [view, setView] = useState<CalculationOutcomeView>(defaultView === "analysis" ? "analysis" : "pre");
  const [groupBy, setGroupBy] = useState<CalculationOutcomeGrouping>(
    GROUPINGS.find((g) => g === defaultGroupBy) ?? "order"
  );
  const [data, setData] = useState<CalculationOutcomeResponse | CalculationAnalysisResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const qs = new URLSearchParams();
    if (view === "analysis") {
      qs.set("view", view);
      qs.set("groupBy", groupBy);
    }
    if (from) qs.set("from", from);
    if (to) qs.set("to", to);
    const qsString = qs.toString();
    router.replace(qsString ? `${pathname}?${qsString}` : pathname, { scroll: false });

    let cancelled = false;
    setLoading(true);
    setError(null);
    apiFetch<CalculationOutcomeResponse | CalculationAnalysisResponse>(`/api/v1/reports/calculation-outcome?${qsString}`)
      .then((res) => {
        if (!cancelled) setData(res);
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        setData(null);
        setError(apiErrorMessage(err, "Kunde inte läsa kalkylutfallet."));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- router/pathname are stable
  }, [from, to, view, groupBy]);

  const csvQs = new URLSearchParams();
  if (data) {
    if (data.view === "analysis") {
      csvQs.set("view", "analysis");
      csvQs.set("groupBy", data.groupBy);
    }
    csvQs.set("from", data.from);
    csvQs.set("to", data.to);
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
          columns={view === "analysis" ? 4 : 3}
        >
          <Field label="Vy" htmlFor="outcomeView">
            <SegmentedToggle<CalculationOutcomeView>
              value={view}
              onChange={setView}
              ariaLabel="Vy"
              options={[
                { value: "pre", label: "Mot förkalkyl" },
                { value: "analysis", label: "Avvikelseanalys" },
              ]}
            />
          </Field>
          {view === "analysis" && (
            <Field label="Gruppera" htmlFor="outcomeGroupBy">
              <Select
                id="outcomeGroupBy"
                value={groupBy}
                onChange={(e) => setGroupBy(e.target.value as CalculationOutcomeGrouping)}
              >
                <option value="order">Order</option>
                <option value="article">Artikel</option>
                <option value="workCenter">Resurs</option>
              </Select>
            </Field>
          )}
        </MonthRangeFields>
      </Card>

      <FormError margin="below">{error}</FormError>
      {loading && <TableSkeleton label="Hämtar kalkylutfallet…" />}

      {data && !loading && data.view === "analysis" && (
        <KalkylutfallAnalysis data={data} csvPath={`/api/v1/reports/calculation-outcome/csv?${csvQs.toString()}`} />
      )}
      {data && !loading && data.view === "pre" && (
        <PreView data={data} csvPath={`/api/v1/reports/calculation-outcome/csv?${csvQs.toString()}`} />
      )}
    </>
  );
}

function PreView({ data, csvPath }: { data: CalculationOutcomeResponse; csvPath: string }) {
  const rows: OutcomeRowWithId[] = data.rows.map((r) => ({ ...r, id: r.manufacturingOrderId }));
  const anyOutput = data.rows.some((r) => r.perUnitBasis === "output");
  return (
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
          <ReportCsvLink path={csvPath} />
        </div>
        <Table<OutcomeRowWithId>
          columns={[
            { key: "orderNumber", label: "TO", width: "100px" },
            { key: "article", label: "Artikel", width: "minmax(180px, 1.6fr)" },
            { key: "quantity", label: "Antal", width: "80px", align: "right" },
            { key: "preTvk", label: "Förkalkyl TVK/st", width: "150px", align: "right" },
            { key: "calcTvk", label: "Kalkylerat TVK/st", width: "150px", align: "right" },
            { key: "postTvk", label: "Efterkalkyl TVK/st", width: "150px", align: "right" },
            { key: "delta", label: "Avvikelse/st", width: "110px", align: "right" },
            { key: "deltaPct", label: "Avvikelse %", width: "100px", align: "right" },
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
                    {row.preSource === "configuration" ? (
                      <span
                        className={deviationStyles.tag}
                        title="Jämförs mot konfigurationens kostnad, räknad i flera nivåer"
                      >
                        konfiguration
                      </span>
                    ) : (
                      row.preMultiLevel && <span className={deviationStyles.tag}>flernivå</span>
                    )}
                    {row.preliminary === true && (
                      <span className={deviationStyles.tag} title="Ordern är inte klar">
                        Ej klar
                      </span>
                    )}
                  </>
                );
              case "quantity":
                return (
                  <>
                    <span className="num">{row.quantity.toLocaleString("sv-SE")}</span>
                    {row.perUnitBasis === "output" && row.outputQuantity !== null && (
                      <span className={deviationStyles.sub}>inlev. {row.outputQuantity.toLocaleString("sv-SE")}</span>
                    )}
                  </>
                );
              case "preTvk":
                return <span className="num">{formatMoney(row.preTvkPerUnit)}</span>;
              case "calcTvk":
                return (
                  <span className="num">
                    {row.calculatedTvkPerUnit === null ? "—" : formatMoney(row.calculatedTvkPerUnit)}
                  </span>
                );
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
        Ej jämförbara: {data.notComparable.onlyPost} utan jämförbar förkalkyl,{" "}
        {data.notComparable.invalidQuantity} med ogiltigt antal, {data.notComparable.noOutput} utan inlevererat
        antal.
      </FormHint>
      <FormHint>
        Efterkalkyl TVK/st räknas per inlevererat antal när efterkalkylens analys är slutlig
        {anyOutput ? " (antalet står under Antal)" : ""}, annars per orderns antal. Kalkylerat TVK/st är orderns egen
        kalkyl per inlevererat antal — Förkalkyl, Kalkylerat och Efterkalkyl visar vad artikelns kalkyl, ordern
        planerade och ordern kostade.
      </FormHint>
    </>
  );
}

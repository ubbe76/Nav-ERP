"use client";

import type { ReactNode } from "react";
import { GatedLink } from "../ui/GatedLink";
import { KpiRow, KpiTile } from "../dashboard/KpiTile";
import { Card } from "../ui/Card";
import { FormHint } from "../ui/Form";
import { Table } from "../ui/Table";
import { Deviation } from "../costing/VarianceSummary";
import { deviationTone, isZeroAmount, type DeviationTone } from "../../lib/costVariance";
import { formatMoney, formatQuantity, formatSignedMoney } from "../../lib/format";
import type {
  CalculationAnalysisResponse,
  CalculationOutcomeGrouping,
  OutcomeAmounts,
  OutcomeArticleRow,
  OutcomeOrderRow,
  OutcomeWorkCenterRow,
} from "../../lib/types";
import deviationStyles from "./Deviation.module.css";
import { ReportCsvLink } from "./ReportCsvLink";
import { formatSignedPercent } from "./reportFormat";

type Row = (OutcomeOrderRow | OutcomeArticleRow | OutcomeWorkCenterRow) & { id: string };

const SIGNAL_TONE: Record<DeviationTone, "alert" | "ok" | "neutral"> = {
  dearer: "alert",
  cheaper: "ok",
  none: "neutral",
};

function signed(value: number): string {
  return isZeroAmount(value) ? formatMoney(0) : formatSignedMoney(value);
}

function Pct({ value }: { value: number | null }) {
  if (value === null) return <span className="num">—</span>;
  const tone = value > 0 ? deviationStyles.over : value < 0 ? deviationStyles.under : "";
  return <span className={`num ${tone}`}>{formatSignedPercent(value)}</span>;
}

function Hours({ value }: { value: number | null }) {
  return <span className="num">{value === null ? "—" : formatQuantity(value)}</span>;
}

function Amount({ value }: { value: number | null }) {
  return <span className="num">{value === null ? "—" : formatMoney(value)}</span>;
}

function Dev({ value }: { value: number | null }) {
  return value === null ? <span className="num">—</span> : <span className="num"><Deviation value={value} /></span>;
}

function Foot({ label, children }: { label: string; children: ReactNode }) {
  return (
    <>
      <span className={deviationStyles.footLabel}>{label}</span>
      {children}
    </>
  );
}

function Money({ value }: { value: number }) {
  return <span className="num">{formatMoney(value)}</span>;
}

// Ställ and Stycke only when some row has the time split (they are 0 until
// the time is registered as ställ/produktion); Ej uppdelad otherwise, or when
// some row still has unsplit time. Timpris only when something is nonzero.
function partColumns(rows: Array<{ parts: OutcomeAmounts["parts"] }>) {
  const nonzero = (pick: (p: OutcomeAmounts["parts"]) => number) => rows.some((r) => !isZeroAmount(pick(r.parts)));
  const split = nonzero((p) => p.setup) || nonzero((p) => p.run);
  return {
    rate: nonzero((p) => p.rate),
    split,
    unclassified: !split || nonzero((p) => p.unclassified),
    markups: nonzero((p) => p.markups),
  };
}

export function KalkylutfallAnalysis({ data, csvPath }: { data: CalculationAnalysisResponse; csvPath: string }) {
  const { kpis, counts, totals } = data;
  const groupBy: CalculationOutcomeGrouping = data.groupBy;
  const rows: Row[] = data.rows.map((r) => ({
    ...r,
    id: "key" in r ? r.key : "manufacturingOrderId" in r ? r.manufacturingOrderId : r.articleId,
  }));

  const kpiTone = SIGNAL_TONE[deviationTone(kpis.deviation)];
  const pctText = kpis.deviationPct === null ? "" : `${formatSignedPercent(kpis.deviationPct)} mot kalkylerat`;

  return (
    <>
      <KpiRow>
        <KpiTile label="Total avvikelse" value={signed(kpis.deviation)} unit="kr" signal={pctText || undefined} tone={kpiTone} />
        <KpiTile label="Pris" value={signed(kpis.price)} unit="kr" tone={SIGNAL_TONE[deviationTone(kpis.price)]} />
        <KpiTile
          label="Mängd"
          value={signed(kpis.quantity)} unit="kr"
          signal={isZeroAmount(kpis.scrap) ? undefined : `varav kassation ${signed(kpis.scrap)} kr`}
          tone={SIGNAL_TONE[deviationTone(kpis.quantity)]}
        />
        <KpiTile label="Tid" value={signed(kpis.time)} unit="kr" tone={SIGNAL_TONE[deviationTone(kpis.time)]} />
      </KpiRow>
      {!isZeroAmount(kpis.markups) && (
        <FormHint>Påslag (följer av material och lego) {signed(kpis.markups)} kr ingår i Total avvikelse.</FormHint>
      )}

      <Card maxWidth="none" style={{ margin: "16px 0" }}>
        <div style={{ display: "flex", justifyContent: "flex-end", marginBottom: 12 }}>
          <ReportCsvLink path={csvPath} />
        </div>
        {groupBy === "workCenter" ? (
          <WorkCenterTable rows={rows as Array<OutcomeWorkCenterRow & { id: string }>} />
        ) : (
          <OrderArticleTable
            groupBy={groupBy}
            rows={rows as Array<(OutcomeOrderRow | OutcomeArticleRow) & { id: string }>}
            totals={totals}
          />
        )}
      </Card>

      <div className={deviationStyles.counters}>
        <FormHint>{counts.analysed} analyserade ordrar ingår.</FormHint>
        <FormHint>{counts.preliminary} preliminära (Ej klar) räknas inte med.</FormHint>
        <FormHint>{counts.withoutAnalysis} utan analys (sparad före avvikelseanalysen) räknas inte med.</FormHint>
      </div>
      <FormHint>
        Plus betyder dyrare än kalkylerat. Kalkylerat är orderns egna rader prissatta när ordern skapades, och Pris +
        Mängd + Tid + Påslag är exakt Avvikelse.
        {groupBy === "workCenter" && " Per resurs ingår bara operationerna; material och påslag har ingen resurs."}
      </FormHint>
    </>
  );
}

function OrderArticleTable({
  groupBy,
  rows,
  totals,
}: {
  groupBy: "order" | "article";
  rows: Array<(OutcomeOrderRow | OutcomeArticleRow) & { id: string }>;
  totals: OutcomeAmounts;
}) {
  const show = partColumns(rows);
  const columns = [
    ...(groupBy === "order"
      ? [{ key: "order", label: "TO", width: "110px" }]
      : []),
    { key: "article", label: "Artikel", width: "minmax(200px, 1.6fr)" },
    ...(groupBy === "article" ? [{ key: "orderCount", label: "Antal TO", width: "90px", align: "right" as const }] : []),
    { key: "output", label: "Inlevererat", width: "100px", align: "right" as const },
    { key: "base", label: "Kalkylerat", width: "110px", align: "right" as const },
    { key: "actual", label: "Utfall", width: "110px", align: "right" as const },
    { key: "deviation", label: "Avvikelse", width: "130px", align: "right" as const },
    { key: "pct", label: "Avvikelse %", width: "110px", align: "right" as const },
    { key: "price", label: "Pris", width: "110px", align: "right" as const },
    { key: "quantity", label: "Mängd", width: "120px", align: "right" as const },
    ...(show.rate ? [{ key: "rate", label: "Timpris", width: "100px", align: "right" as const }] : []),
    ...(show.split
      ? [
          { key: "setup", label: "Ställ", width: "100px", align: "right" as const },
          { key: "run", label: "Stycke", width: "100px", align: "right" as const },
        ]
      : []),
    ...(show.unclassified ? [{ key: "unclassified", label: "Ej uppdelad", width: "110px", align: "right" as const }] : []),
    ...(show.markups ? [{ key: "markups", label: "Påslag", width: "100px", align: "right" as const }] : []),
  ];

  const footer: Record<string, ReactNode> = {
    article: <strong>Totalt</strong>,
    base: <Foot label="Kalkylerat"><Money value={totals.base} /></Foot>,
    actual: <Foot label="Utfall"><Money value={totals.actual} /></Foot>,
    deviation: <Foot label="Avvikelse"><Dev value={totals.deviation} /></Foot>,
    pct: <Foot label="Avvikelse %"><Pct value={totals.deviationPct} /></Foot>,
    price: <Foot label="Pris"><Dev value={totals.parts.price} /></Foot>,
    quantity: <Foot label="Mängd"><Dev value={totals.parts.quantity} /></Foot>,
    rate: <Foot label="Timpris"><Dev value={totals.parts.rate} /></Foot>,
    setup: <Foot label="Ställ"><Dev value={totals.parts.setup} /></Foot>,
    run: <Foot label="Stycke"><Dev value={totals.parts.run} /></Foot>,
    unclassified: <Foot label="Ej uppdelad"><Dev value={totals.parts.unclassified} /></Foot>,
    markups: <Foot label="Påslag"><Dev value={totals.parts.markups} /></Foot>,
  };

  return (
    <Table<(OutcomeOrderRow | OutcomeArticleRow) & { id: string }>
      columns={columns}
      rows={rows}
      emptyText="Inga analyserade ordrar i perioden."
      footer={footer}
      renderCell={(row, key) => {
        const order = "manufacturingOrderId" in row ? row : null;
        switch (key) {
          case "order":
            return order ? <GatedLink href={`/tillverkning/ordrar/${order.manufacturingOrderId}`}>{order.orderNumber}</GatedLink> : null;
          case "article":
            return (
              <>
                {row.articleNumber} — {row.articleName}
              </>
            );
          case "orderCount":
            return <span className="num">{"orderCount" in row ? row.orderCount : ""}</span>;
          case "output":
            return <Hours value={row.outputQuantity} />;
          case "base":
            return <Money value={row.base} />;
          case "actual":
            return <Money value={row.actual} />;
          case "deviation":
            return <Dev value={row.deviation} />;
          case "pct":
            return <Pct value={row.deviationPct} />;
          case "price":
            return <Dev value={row.parts.price} />;
          case "quantity":
            return (
              <>
                <Dev value={row.parts.quantity} />
                {!isZeroAmount(row.parts.scrap) && (
                  <span className={deviationStyles.sub}>varav kassation {formatSignedMoney(row.parts.scrap)}</span>
                )}
              </>
            );
          case "rate":
            return <Dev value={row.parts.rate} />;
          case "setup":
            return <Dev value={row.parts.setup} />;
          case "run":
            return <Dev value={row.parts.run} />;
          case "unclassified":
            return <Dev value={row.parts.unclassified} />;
          case "markups":
            return <Dev value={row.parts.markups} />;
          default:
            return null;
        }
      }}
    />
  );
}

function WorkCenterTable({ rows }: { rows: Array<OutcomeWorkCenterRow & { id: string }> }) {
  const hasActualSplit = rows.some((r) => r.setupHours !== null || r.runHours !== null);
  const hasUnclassified = rows.some((r) => (r.unclassifiedHours ?? 0) !== 0) || !hasActualSplit;
  const hasSubcontract = rows.some((r) => r.kind === "subcontract");
  const right = "right" as const;
  const columns = [
    { key: "resource", label: "Resurs", width: "minmax(180px, 1.4fr)" },
    { key: "kind", label: "Slag", width: "90px" },
    { key: "operations", label: "Operationer", width: "100px", align: right },
    { key: "orders", label: "Antal TO", width: "90px", align: right },
    { key: "baseSetup", label: "Planerad ställ (h)", width: "120px", align: right },
    ...(hasActualSplit ? [{ key: "setup", label: "Verklig ställ (h)", width: "120px", align: right }] : []),
    { key: "baseRun", label: "Planerad stycke (h)", width: "130px", align: right },
    ...(hasActualSplit ? [{ key: "run", label: "Verklig stycke (h)", width: "120px", align: right }] : []),
    ...(hasUnclassified ? [{ key: "unclassified", label: "Ej uppdelad (h)", width: "120px", align: right }] : []),
    { key: "hours", label: "Rapporterat (h)", width: "120px", align: right },
    { key: "timeDeviation", label: "Tidsavvikelse (kr)", width: "140px", align: right },
    ...(hasSubcontract
      ? [
          { key: "base", label: "Kalkylerat", width: "110px", align: right },
          { key: "actual", label: "Utfall", width: "110px", align: right },
          { key: "price", label: "Pris", width: "110px", align: right },
          { key: "quantity", label: "Mängd", width: "110px", align: right },
        ]
      : []),
  ];
  const timeRows = rows.filter((r) => r.kind === "time");
  const legoRows = rows.filter((r) => r.kind === "subcontract");
  const sum = (pick: (r: OutcomeWorkCenterRow) => number | null) =>
    Math.round(timeRows.reduce((t, r) => t + (pick(r) ?? 0), 0) * 1e4) / 1e4;
  const footer: Record<string, ReactNode> = {
    resource: <strong>Totalt</strong>,
    timeDeviation: <Foot label="Tidsavvikelse (kr)"><Dev value={timeRows.reduce((t, r) => t + (r.timeDeviation ?? 0), 0)} /></Foot>,
    hours: <Foot label="Rapporterat (h)"><Hours value={sum((r) => r.hours)} /></Foot>,
    base: <Foot label="Kalkylerat"><Money value={legoRows.reduce((t, r) => t + r.base, 0)} /></Foot>,
    actual: <Foot label="Utfall"><Money value={legoRows.reduce((t, r) => t + r.actual, 0)} /></Foot>,
    price: <Foot label="Pris"><Dev value={legoRows.reduce((t, r) => t + r.parts.price, 0)} /></Foot>,
    quantity: <Foot label="Mängd"><Dev value={legoRows.reduce((t, r) => t + r.parts.quantity, 0)} /></Foot>,
  };

  return (
    <Table<OutcomeWorkCenterRow & { id: string }>
      columns={columns}
      rows={rows}
      emptyText="Inga analyserade operationer i perioden."
      footer={footer}
      renderCell={(row, key) => {
        const lego = row.kind === "subcontract";
        switch (key) {
          case "resource":
            return (
              <>
                {row.workCenterCode} — {row.workCenterName}
              </>
            );
          case "kind":
            return lego ? "Lego" : "Tid";
          case "operations":
            return <span className="num">{row.operationCount}</span>;
          case "orders":
            return <span className="num">{row.orderCount}</span>;
          case "baseSetup":
            return <Hours value={row.baseSetupHours} />;
          case "setup":
            return <Hours value={row.setupHours} />;
          case "baseRun":
            return <Hours value={row.baseRunHours} />;
          case "run":
            return <Hours value={row.runHours} />;
          case "unclassified":
            return <Hours value={row.unclassifiedHours} />;
          case "hours":
            return <Hours value={row.hours} />;
          case "timeDeviation":
            return <Dev value={row.timeDeviation} />;
          case "base":
            return lego ? (
              <>
                <Amount value={row.base} />
                <span className={deviationStyles.sub}>{formatQuantity(row.baseQuantity ?? 0)} st</span>
              </>
            ) : (
              <span className="num">—</span>
            );
          case "actual":
            return lego ? (
              <>
                <Amount value={row.actual} />
                <span className={deviationStyles.sub}>{formatQuantity(row.subcontractQuantity ?? 0)} st</span>
              </>
            ) : (
              <span className="num">—</span>
            );
          case "price":
            return lego ? <Dev value={row.parts.price} /> : <span className="num">—</span>;
          case "quantity":
            return lego ? <Dev value={row.parts.quantity} /> : <span className="num">—</span>;
          default:
            return null;
        }
      }}
    />
  );
}

"use client";

import { useEffect, useState } from "react";
import { useSearchParams } from "next/navigation";
import { apiFetch } from "../../lib/api";
import { apiErrorMessage } from "../../lib/errorMessages";
import { formatStockholmDate, addDaysIso } from "../../lib/date";
import { formatQuantity } from "../../lib/format";
import { isoWeekNumber } from "../../lib/deliveryTimeCheck";
import type { RunPlanResult, RunPlanRow, RunPlanWeek } from "../../lib/types";
import { Select } from "../ui/Field";
import { FormError, FormHint } from "../ui/Form";
import { GatedLink } from "../ui/GatedLink";
import { StatusPill, type Status } from "../ui/StatusPill";
import { Table } from "../ui/Table";
import { useListNavigation } from "../ui/ListControls";
import buttonStyles from "../ui/Button.module.css";
import styles from "./RunPlanPageClient.module.css";

// Körplan: the waiting operations on one resource, grouped by week. The API
// owns urval, ordning, veckonyckel and Tid kvar; this page only presents.

const WEEKS_AHEAD = 52;

const formatHours = (hours: number): string =>
  hours.toLocaleString("sv-SE", { minimumFractionDigits: 2, maximumFractionDigits: 2 });

// Same wording as the PDF.
function statusText(row: RunPlanRow): string {
  switch (row.status) {
    case "planned_order":
      return "Planerad TO";
    case "ready":
      return "Redo";
    case "partial":
      return `${formatQuantity(row.available ?? 0)} redo · väntar på op ${row.waitingForSequenceNo ?? ""}`.trim();
    default:
      return `Väntar på op ${row.waitingForSequenceNo ?? ""}`.trim();
  }
}

const STATUS_PILL: Record<RunPlanRow["status"], Status> = {
  planned_order: "draft",
  ready: "done",
  partial: "delayed",
  not_ready: "stopped",
};

function groupOf(row: RunPlanRow): string {
  if (row.late) return "late";
  if (row.week === null) return "unplanned";
  return row.week;
}

function groupKey(week: RunPlanWeek): string {
  return week.kind === "week" ? (week.week ?? "") : week.kind;
}

function groupTitle(week: RunPlanWeek): string {
  if (week.kind === "late") return "Försenad";
  if (week.kind === "unplanned") return "Ej planerad";
  return `Vecka ${week.isoWeek}`;
}

// "v.51", with the ISO year when it is not the current week's (short enough
// for the picker on a phone). The ISO year is the year of the week's Thursday.
function weekOptionLabel(monday: string, currentWeek: string | undefined): string {
  const isoYear = (m: string) => addDaysIso(m, 3).slice(0, 4);
  const year = currentWeek && isoYear(monday) !== isoYear(currentWeek) ? ` ${isoYear(monday)}` : "";
  return `v.${isoWeekNumber(monday)}${year}`;
}

interface TableRow extends RunPlanRow {
  id: string;
}

const COLUMNS = [
  { key: "week", label: "Vecka", width: "70px" },
  { key: "order", label: "TO", width: "110px" },
  { key: "article", label: "Artikel", width: "minmax(180px, 2fr)" },
  { key: "operation", label: "Operation", width: "minmax(150px, 2fr)" },
  { key: "quantity", label: "Antal kvar", width: "100px", align: "right" as const },
  { key: "hours", label: "Tid kvar (h)", width: "100px", align: "right" as const },
  { key: "due", label: "Färdigdatum", width: "110px" },
  { key: "status", label: "Status", width: "minmax(190px, 1.5fr)" },
];

function renderCell(row: TableRow, key: string) {
  switch (key) {
    case "week":
      return row.week ? `v.${isoWeekNumber(row.week)}` : "–";
    case "order":
      return (
        <GatedLink href={`/tillverkning/ordrar/${row.manufacturingOrderId}`} className={styles.orderLink}>
          {row.orderNumber}
        </GatedLink>
      );
    case "article":
      return (
        // One element: the mobile card spreads a cell's children apart.
        <span>
          <span className="num">{row.articleNumber}</span> {row.articleName}
        </span>
      );
    case "operation":
      return `Op ${row.sequenceNo}${row.description ? ` ${row.description}` : ""}`;
    case "quantity":
      return <span className="num">{formatQuantity(row.remainingQuantity)}</span>;
    case "hours":
      return <span className="num">{formatHours(row.remainingHours)}</span>;
    case "due":
      return formatStockholmDate(row.dueDate);
    default:
      return (
        <span className={styles.statusCell}>
          <StatusPill status={STATUS_PILL[row.status]} label={statusText(row)} compact />
          {row.planLocked && <span className={styles.lockBadge}>Låst</span>}
        </span>
      );
  }
}

export function RunPlanPageClient() {
  const searchParams = useSearchParams();
  const { setFilter } = useListNavigation();
  const resource = searchParams.get("resurs") ?? "";
  const tom = searchParams.get("tom") ?? "";

  const [data, setData] = useState<RunPlanResult | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    const qs = new URLSearchParams();
    if (resource) qs.set("workCenterId", resource);
    if (tom) qs.set("toWeek", tom);
    const query = qs.toString();
    apiFetch<RunPlanResult>(`/api/v1/planning/run-plan${query ? `?${query}` : ""}`)
      .then((res) => {
        if (!cancelled) setData(res);
      })
      .catch((err: unknown) => {
        if (!cancelled) setError(apiErrorMessage(err, "Kunde inte hämta körplanen"));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [resource, tom]);

  const stations = data?.stations ?? [];
  const toWeek = data?.toWeek ?? "";
  const weekOptions: string[] = [];
  if (data) {
    for (let i = 0; i <= WEEKS_AHEAD; i++) weekOptions.push(addDaysIso(data.currentWeek, i * 7));
    if (!weekOptions.includes(toWeek)) weekOptions.push(toWeek);
    weekOptions.sort();
  }

  const pdfQuery = new URLSearchParams({ workCenterId: resource });
  if (tom) pdfQuery.set("toWeek", tom);

  const groups = (data?.weeks ?? []).filter((w) => w.rows > 0);
  const rowsByGroup = new Map<string, TableRow[]>();
  for (const row of data?.rows ?? []) {
    const key = groupOf(row);
    const list = rowsByGroup.get(key) ?? [];
    list.push({ ...row, id: row.key });
    rowsByGroup.set(key, list);
  }

  return (
    <>
      <div className={styles.toolbar}>
        <label className={styles.field}>
          <span className={styles.label}>Resurs</span>
          <Select size="sm" value={resource} onChange={(e) => setFilter("resurs", e.target.value || null)} aria-label="Resurs">
            <option value="">Välj en resurs</option>
            {stations.map((s) => (
              <option key={s.id} value={s.id}>
                {s.code} · {s.name}
              </option>
            ))}
          </Select>
        </label>
        <label className={styles.field}>
          <span className={styles.label}>T.o.m. vecka</span>
          <Select
            size="sm"
            value={toWeek}
            disabled={!data}
            onChange={(e) => setFilter("tom", e.target.value || null)}
            aria-label="T.o.m. vecka"
          >
            {weekOptions.map((w) => (
              <option key={w} value={w}>
                {weekOptionLabel(w, data?.currentWeek)}
              </option>
            ))}
          </Select>
        </label>
        {resource && data?.workCenter ? (
          <a
            href={`/api/v1/planning/run-plan/pdf?${pdfQuery.toString()}`}
            target="_blank"
            rel="noopener noreferrer"
            className={`${buttonStyles.button} ${buttonStyles.ghost}`}
          >
            Skriv ut
          </a>
        ) : null}
      </div>

      <FormError margin="below">{error}</FormError>

      {!resource && !error && <FormHint>Välj en resurs</FormHint>}

      {resource && data?.workCenter && data.rows.length === 0 && !loading && (
        <FormHint>Inga kommande arbeten på resursen t.o.m. vecka {isoWeekNumber(toWeek)}</FormHint>
      )}

      {resource && data?.workCenter && data.rows.length > 0 && (
        <>
          {groups.map((group) => (
            <section key={groupKey(group)} className={styles.group}>
              <h2 className={styles.groupHeader}>
                <span>{groupTitle(group)}</span>
                <span className={`${styles.groupHours} num`}>{formatHours(group.hours)} h</span>
              </h2>
              <Table columns={COLUMNS} rows={rowsByGroup.get(groupKey(group)) ?? []} renderCell={renderCell} />
            </section>
          ))}
          <div className={styles.total}>
            <span>Totalt</span>
            <span className="num">{formatHours(data.totalHours)} h</span>
          </div>
        </>
      )}
    </>
  );
}

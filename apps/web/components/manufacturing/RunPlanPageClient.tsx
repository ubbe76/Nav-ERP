"use client";

import { PrintButton } from "../documents/PrintButton";
import { useCallback, useEffect, useState } from "react";
import { ArrowDown, ArrowUp } from "lucide-react";
import { useSearchParams } from "next/navigation";
import { apiFetch } from "../../lib/api";
import { apiErrorMessage } from "../../lib/errorMessages";
import { formatStockholmDate } from "../../lib/date";
import { RUN_PLAN_STATUS_PILL, runPlanStatusText } from "../../lib/dayPlan";
import { formatQuantity } from "../../lib/format";
import { shortDate, weekdayShortDate } from "../../lib/planning";
import type { RunPlanOrderResult, RunPlanResult, RunPlanRow, RunPlanDay } from "../../lib/types";
import { useCan } from "../PermissionsProvider";
import { Input, Select } from "../ui/Field";
import { FormError, FormHint } from "../ui/Form";
import { GatedLink } from "../ui/GatedLink";
import { StatusPill } from "../ui/StatusPill";
import { Table } from "../ui/Table";
import { useListNavigation } from "../ui/ListControls";
import styles from "./RunPlanPageClient.module.css";

// Körplan: the waiting operations on one resource, grouped by day. The API
// owns urval, ordning, dagnyckel and Tid kvar; this page only presents.

const formatHours = (hours: number): string =>
  hours.toLocaleString("sv-SE", { minimumFractionDigits: 2, maximumFractionDigits: 2 });

function groupOf(row: RunPlanRow): string {
  if (row.late) return "late";
  if (row.date === null) return "unplanned";
  return row.date;
}

function groupKey(day: RunPlanDay): string {
  return day.kind === "day" ? (day.date ?? "") : day.kind;
}

// "mån 16 nov · v.47": the day with its ISO week number.
function groupTitle(day: RunPlanDay): string {
  if (day.kind === "late") return "Försenad";
  if (day.kind === "unplanned") return "Ej planerad";
  return `${day.date ? weekdayShortDate(day.date) : ""} · v.${day.isoWeek}`;
}

interface TableRow extends RunPlanRow {
  id: string;
}

const COLUMNS = [
  { key: "week", label: "Dag", width: "100px" },
  { key: "order", label: "TO", width: "110px" },
  { key: "article", label: "Artikel", width: "minmax(180px, 2fr)" },
  { key: "operation", label: "Operation", width: "minmax(150px, 2fr)" },
  { key: "quantity", label: "Antal kvar", width: "100px", align: "right" as const },
  { key: "hours", label: "Tid kvar (h)", width: "100px", align: "right" as const },
  { key: "due", label: "Färdigdatum", width: "110px" },
  { key: "status", label: "Status", width: "minmax(190px, 1.5fr)" },
];
// Upp/Ned: only shown in a reorderable group for users with Tillverkning.
const MOVE_COLUMN = { key: "move", label: "Ordning", width: "96px" };

interface MoveControls {
  // Index of the row among its group's orderable rows, and their count.
  position: number;
  count: number;
  busy: boolean;
  onMove: (direction: -1 | 1) => void;
}

function renderCell(row: TableRow, key: string, move?: MoveControls) {
  switch (key) {
    case "move":
      return move ? (
        <span className={styles.moveCell}>
          <button
            type="button"
            className={styles.moveButton}
            aria-label="Flytta upp"
            disabled={move.busy || move.position === 0}
            onClick={() => move.onMove(-1)}
          >
            <ArrowUp size={16} aria-hidden="true" />
          </button>
          <button
            type="button"
            className={styles.moveButton}
            aria-label="Flytta ned"
            disabled={move.busy || move.position === move.count - 1}
            onClick={() => move.onMove(1)}
          >
            <ArrowDown size={16} aria-hidden="true" />
          </button>
        </span>
      ) : null;
    case "week":
      return row.date ? weekdayShortDate(row.date) : "–";
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
          <StatusPill status={RUN_PLAN_STATUS_PILL[row.status]} label={runPlanStatusText(row)} compact />
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

  const canOrder = useCan()(["tillverkning"]);
  const [data, setData] = useState<RunPlanResult | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [reloadTick, setReloadTick] = useState(0);
  const [ordering, setOrdering] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    const qs = new URLSearchParams();
    if (resource) qs.set("workCenterId", resource);
    if (tom) qs.set("toDate", tom);
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
  }, [resource, tom, reloadTick]);

  // Swap one row with its neighbour and send the whole day's order.
  const moveRow = useCallback(
    async (group: RunPlanDay, ids: string[], index: number, direction: -1 | 1) => {
      const target = index + direction;
      if (!resource || !group.date || target < 0 || target >= ids.length) return;
      const next = [...ids];
      [next[index], next[target]] = [next[target]!, next[index]!];
      setOrdering(true);
      setError(null);
      try {
        await apiFetch<RunPlanOrderResult>("/api/v1/planning/run-plan/order", {
          method: "PUT",
          body: JSON.stringify({ workCenterId: resource, date: group.date, moOperationIds: next }),
        });
      } catch (err) {
        setError(apiErrorMessage(err, "Kunde inte ändra ordningen"));
      } finally {
        setOrdering(false);
        // Also after a 409: the plan changed meanwhile, show it as it is.
        setReloadTick((n) => n + 1);
      }
    },
    [resource]
  );

  const stations = data?.stations ?? [];
  const toDate = data?.toDate ?? "";

  const pdfQuery = new URLSearchParams({ workCenterId: resource });
  if (tom) pdfQuery.set("toDate", tom);

  const groups = (data?.days ?? []).filter((w) => w.rows > 0);
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
          <span className={styles.label}>T.o.m.</span>
          <Input
            size="sm"
            type="date"
            value={toDate}
            disabled={!data}
            onChange={(e) => setFilter("tom", e.target.value || null)}
            aria-label="T.o.m."
          />
        </label>
        {resource && data?.workCenter ? (
          <PrintButton href={`/api/v1/planning/run-plan/pdf?${pdfQuery.toString()}`} size="default" />
        ) : null}
      </div>

      <FormError margin="below">{error}</FormError>

      {!resource && !error && <FormHint>Välj en resurs</FormHint>}

      {resource && data?.workCenter && data.rows.length === 0 && !loading && (
        <FormHint>Inga kommande arbeten på resursen t.o.m. {shortDate(toDate)}</FormHint>
      )}

      {resource && data?.workCenter && data.rows.length > 0 && (
        <>
          {groups.map((group) => {
            const groupRows = rowsByGroup.get(groupKey(group)) ?? [];
            const orderable = canOrder && group.reorderable;
            // The API decides per row: only the planned operations of the
            // day — an unplanned one on its due date is not in the day's
            // order, and sending it would be a 409 every time.
            const ids = groupRows.flatMap((r) => (r.reorderable && r.moOperationId ? [r.moOperationId] : []));
            return (
            <section key={groupKey(group)} className={styles.group}>
              <h2 className={styles.groupHeader}>
                <span>{groupTitle(group)}</span>
                <span className={`${styles.groupHours} num`}>{formatHours(group.hours)} h</span>
              </h2>
              <Table
                columns={orderable ? [...COLUMNS, MOVE_COLUMN] : COLUMNS}
                rows={groupRows}
                renderCell={(row, key) => {
                  if (key !== "move") return renderCell(row, key);
                  const index = row.reorderable && row.moOperationId ? ids.indexOf(row.moOperationId) : -1;
                  if (index < 0) return null;
                  return renderCell(row, key, {
                    position: index,
                    count: ids.length,
                    busy: ordering || loading,
                    onMove: (direction) => void moveRow(group, ids, index, direction),
                  });
                }}
              />
            </section>
            );
          })}
          <div className={styles.total}>
            <span>Totalt</span>
            <span className="num">{formatHours(data.totalHours)} h</span>
          </div>
        </>
      )}
    </>
  );
}

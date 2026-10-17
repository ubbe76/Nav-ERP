"use client";

import { useEffect, useState, type KeyboardEvent } from "react";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { StatusPill } from "../ui/StatusPill";
import { Select } from "../ui/Field";
import { ListFilterSelect, useListNavigation } from "../ui/ListControls";
import { Button } from "../ui/Button";
import { FormError, FormNotice } from "../ui/Form";
import { MoveOperationDialog, type MoveTarget } from "./MoveOperationDialog";
import { Clock, Lock } from "lucide-react";
import { apiFetch } from "../../lib/api";
import { confirmDialog } from "../../lib/confirm";
import { apiErrorMessage } from "../../lib/errorMessages";
import { formatStockholmDateTime } from "../../lib/date";
import { plannedWeekLabel } from "../../lib/planning";
import { useCan } from "../PermissionsProvider";
import type {
  CapacityCell,
  CapacityCellOrder,
  CapacityGroupBlock,
  CapacityResourceRow,
  CapacityResult,
  CapacityWeek,
  PlanResult,
  ProductionGroup,
} from "../../lib/types";
import styles from "./BelaggningPageClient.module.css";

const WEEK_OPTIONS = [4, 8, 13, 26];
const DEFAULT_WEEKS = 8;

function toneFor(loadPercent: number | null): "neutral" | "warn" | "alert" {
  if (loadPercent === null) return "neutral";
  if (loadPercent > 100) return "alert";
  if (loadPercent > 85) return "warn";
  return "neutral";
}

function formatHours(hours: number): string {
  return hours.toLocaleString("sv-SE", { maximumFractionDigits: 1 });
}

// Include the ISO year in the week label only when the horizon actually
// spans two of them (e.g. "v.1 2027") — otherwise it's just noise.
function weekLabel(week: CapacityWeek, spansMultipleYears: boolean): string {
  return spansMultipleYears ? `v.${week.isoWeek} ${week.isoYear}` : `v.${week.isoWeek}`;
}

// Which cell is currently expanded (drill-down row shown right under its
// resource). Carries the cell's own data — no re-fetch needed to render it.
interface ExpandedCell {
  key: string;
  workCenterId: string;
  label: string;
  cell: CapacityCell;
}

export function BelaggningPageClient() {
  const searchParams = useSearchParams();
  const { setFilter } = useListNavigation();
  const queryKey = searchParams.toString();

  const [groups, setGroups] = useState<ProductionGroup[]>([]);
  const [data, setData] = useState<CapacityResult | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<ExpandedCell | null>(null);
  // Produktionsplanering: Planera, the summary lists and Flytta….
  const canPlan = useCan()(["tillverkning"]);
  const [reloadTick, setReloadTick] = useState(0);
  const [planBusy, setPlanBusy] = useState(false);
  const [planError, setPlanError] = useState<string | null>(null);
  const [planResult, setPlanResult] = useState<PlanResult | null>(null);
  const [showAllWarnings, setShowAllWarnings] = useState(false);
  const [summaryList, setSummaryList] = useState<SummaryList | null>(null);
  const [moveTarget, setMoveTarget] = useState<MoveTarget | null>(null);

  useEffect(() => {
    apiFetch<ProductionGroup[]>("/api/v1/production-groups").then(setGroups).catch(() => setGroups([]));
  }, []);

  const weeksRaw = Number(searchParams.get("weeks"));
  const weeks = WEEK_OPTIONS.includes(weeksRaw) ? weeksRaw : DEFAULT_WEEKS;
  const productionGroupId = searchParams.get("productionGroupId") ?? "";

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setLoadError(null);
    setExpanded(null);
    const qs = new URLSearchParams({ weeks: String(weeks) });
    if (productionGroupId) qs.set("productionGroupId", productionGroupId);
    apiFetch<CapacityResult>(`/api/v1/planning/capacity?${qs.toString()}`)
      .then((res) => {
        if (cancelled) return;
        setData(res);
      })
      .catch((err: Error) => {
        if (cancelled) return;
        setData(null);
        setLoadError(err.message);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- queryKey mirrors weeks/productionGroupId
  }, [queryKey, reloadTick]);

  async function runPlan() {
    const ok = await confirmDialog(
      "Planera om alla öppna tillverkningsordrar på ledig kapacitet? Veckor som flyttats för hand ligger kvar.",
      { confirmLabel: "Planera" }
    );
    if (!ok) return;
    setPlanError(null);
    setPlanResult(null);
    setShowAllWarnings(false);
    setPlanBusy(true);
    try {
      setPlanResult(await apiFetch<PlanResult>("/api/v1/planning/plan", { method: "POST" }));
      setReloadTick((n) => n + 1);
    } catch (err) {
      setPlanError(apiErrorMessage(err, "Kunde inte planera"));
    } finally {
      setPlanBusy(false);
    }
  }

  function toggleCell(resource: CapacityResourceRow, colKey: string, label: string, cell: CapacityCell) {
    if (cell.orders.length === 0) return;
    const key = `${resource.workCenterId}:${colKey}`;
    setExpanded((prev) => (prev?.key === key ? null : { key, workCenterId: resource.workCenterId, label, cell }));
  }

  function openMove(resource: CapacityResourceRow, order: CapacityCellOrder) {
    setMoveTarget({ order, resource });
  }

  const overloadedList = data ? overloadedCellList(data) : [];
  const spansMultipleYears = data ? new Set(data.weeks.map((w) => w.isoYear)).size > 1 : false;
  const gridTemplateColumns = data ? `220px repeat(${data.weeks.length + 2}, minmax(96px, 1fr))` : undefined;

  return (
    <>
      <div className={styles.toolbar}>
        <ListFilterSelect
          param="productionGroupId"
          allLabel="Alla produktionsgrupper"
          ariaLabel="Filtrera på produktionsgrupp"
          options={groups.map((g) => ({ value: g.id, label: `${g.code} · ${g.name}` }))}
        />
        <label htmlFor="weeksSelect" style={{ fontSize: 13, color: "var(--color-text-secondary)" }}>
          Veckor
        </label>
        <Select
          id="weeksSelect"
          size="xs"
          value={String(weeks)}
          onChange={(e) => setFilter("weeks", Number(e.target.value) === DEFAULT_WEEKS ? null : e.target.value)}
          aria-label="Antal veckor"
        >
          {WEEK_OPTIONS.map((w) => (
            <option key={w} value={w}>
              {w}
            </option>
          ))}
        </Select>
        {canPlan && (
          <Button type="button" variant="primary" size="small" disabled={planBusy} onClick={runPlan}>
            {planBusy ? "Planerar…" : "Planera"}
          </Button>
        )}
      </div>

      <FormError margin="below">{loadError}</FormError>
      <FormError margin="below">{planError}</FormError>

      {planResult && (
        <FormNotice className={styles.planNotice}>
          <div>
            Planerade {planResult.operations} {planResult.operations === 1 ? "operation" : "operationer"} på{" "}
            {planResult.orders} {planResult.orders === 1 ? "tillverkningsorder" : "tillverkningsordrar"}
            {planResult.warnings.length > 0 ? ` — ${planResult.warnings.length} varning${planResult.warnings.length === 1 ? "" : "ar"}:` : "."}
          </div>
          {planResult.warnings.length > 0 && (
            <ul className={styles.warningList}>
              {(showAllWarnings ? planResult.warnings : planResult.warnings.slice(0, 10)).map((w, i) => (
                <li key={i}>
                  <Link href={`/tillverkning/ordrar/${w.manufacturingOrderId}`} className={styles.noticeLink}>
                    {w.orderNumber}
                  </Link>
                  : {w.message}
                </li>
              ))}
            </ul>
          )}
          {!showAllWarnings && planResult.warnings.length > 10 && (
            <button type="button" className={styles.linkButton} onClick={() => setShowAllWarnings(true)}>
              Visa alla ({planResult.warnings.length})
            </button>
          )}
        </FormNotice>
      )}

      {data && (
        <PlanSummary
          summary={data.summary}
          overloaded={overloadedList}
          open={summaryList}
          onOpen={(list) => setSummaryList((prev) => (prev === list ? null : list))}
        />
      )}

      {!loading && data && data.groups.length === 0 && <p>Inga släppta tillverkningsordrar med återstående tid.</p>}

      {data && data.groups.length > 0 && (
        <div className={styles.scroller}>
          <div className={styles.grid} style={{ gridTemplateColumns }}>
            <div className={styles.headerLabel}>Resurs</div>
            {data.weeks.map((w, i) => (
              <div key={i} className={styles.headerCell}>
                {weekLabel(w, spansMultipleYears)}
              </div>
            ))}
            <div className={styles.headerCell}>Senare</div>
            <div className={styles.headerCell}>Odaterat</div>

            {data.groups.map((group) => (
              <GroupBlock
                key={group.productionGroupId ?? "ungrouped"}
                group={group}
                weeks={data.weeks}
                spansMultipleYears={spansMultipleYears}
                expanded={expanded}
                onCellClick={toggleCell}
                canMove={canPlan}
                onMove={openMove}
              />
            ))}
          </div>
        </div>
      )}

      <MoveOperationDialog
        target={moveTarget}
        weeks={data?.weeks ?? []}
        onClose={() => setMoveTarget(null)}
        onChanged={() => setReloadTick((n) => n + 1)}
      />
    </>
  );
}

function GroupBlock({
  group,
  weeks,
  spansMultipleYears,
  expanded,
  onCellClick,
  canMove,
  onMove,
}: {
  group: CapacityGroupBlock;
  weeks: CapacityWeek[];
  spansMultipleYears: boolean;
  expanded: ExpandedCell | null;
  onCellClick: (resource: CapacityResourceRow, colKey: string, label: string, cell: CapacityCell) => void;
  canMove: boolean;
  onMove: (resource: CapacityResourceRow, order: CapacityCellOrder) => void;
}) {
  return (
    <>
      <div className={styles.groupHeader}>{group.code ? `${group.code} · ${group.name}` : group.name}</div>

      {group.resources.map((resource) => (
        <ResourceBlock
          key={resource.workCenterId}
          resource={resource}
          weeks={weeks}
          spansMultipleYears={spansMultipleYears}
          expanded={expanded}
          onCellClick={onCellClick}
          canMove={canMove}
          onMove={onMove}
        />
      ))}

      <div className={styles.resourceLabel} data-summa="true">
        Summa
      </div>
      {group.weekTotals.map((cell, i) => (
        <CellView key={i} cell={cell} summa />
      ))}
      <CellView cell={group.laterTotal} summa />
      <CellView cell={group.undatedTotal} summa />
    </>
  );
}

function ResourceBlock({
  resource,
  weeks,
  spansMultipleYears,
  expanded,
  onCellClick,
  canMove,
  onMove,
}: {
  resource: CapacityResourceRow;
  weeks: CapacityWeek[];
  spansMultipleYears: boolean;
  expanded: ExpandedCell | null;
  onCellClick: (resource: CapacityResourceRow, colKey: string, label: string, cell: CapacityCell) => void;
  canMove: boolean;
  onMove: (resource: CapacityResourceRow, order: CapacityCellOrder) => void;
}) {
  const isExpandedHere = expanded?.workCenterId === resource.workCenterId;
  const weekLabels = weeks.map((w) => weekLabel(w, spansMultipleYears));

  return (
    <>
      <div className={styles.resourceLabel}>
        <span>
          {resource.code} · {resource.name}
        </span>
        {resource.capacityFactor !== 1 && <span className={styles.factorBadge}>×{resource.capacityFactor}</span>}
        {!resource.hasSchedule && (
          <span className={styles.resourceMuted} title="Saknar veckoschema och timmar per dag">
            —
          </span>
        )}
        {!resource.active && <StatusPill status="draft" label="Inaktiv" compact />}
      </div>

      {resource.weeks.map((cell, i) => {
        const key = `week:${i}`;
        const label = weekLabels[i] ?? "";
        return (
          <CellView
            key={i}
            cell={cell}
            active={expanded?.key === `${resource.workCenterId}:${key}`}
            onClick={cell.orders.length > 0 ? () => onCellClick(resource, key, label, cell) : undefined}
          />
        );
      })}
      <CellView
        cell={resource.later}
        active={expanded?.key === `${resource.workCenterId}:later`}
        onClick={resource.later.orders.length > 0 ? () => onCellClick(resource, "later", "Senare", resource.later) : undefined}
      />
      <CellView
        cell={resource.undated}
        active={expanded?.key === `${resource.workCenterId}:undated`}
        onClick={
          resource.undated.orders.length > 0
            ? () => onCellClick(resource, "undated", "Odaterat", resource.undated)
            : undefined
        }
      />

      {isExpandedHere && expanded && (
        <ExpansionRow
          label={`${resource.code} · ${resource.name} — ${expanded.label}`}
          orders={expanded.cell.orders}
          onMove={canMove ? (order) => onMove(resource, order) : undefined}
        />
      )}
    </>
  );
}

function CellContent({ cell, flags = true }: { cell: CapacityCell; flags?: boolean }) {
  const hasLocked = flags && cell.orders.some((o) => o.planLocked);
  const hasLate = flags && cell.orders.some((o) => o.late);
  return (
    <>
      <span className={styles.cellHours}>
        {formatHours(cell.loadHours)}
        {cell.availableHours !== null && ` / ${formatHours(cell.availableHours)}`}
      </span>
      {cell.loadPercent !== null && (
        <>
          <span className={styles.cellPercent}>{cell.loadPercent}%</span>
          <div className={styles.fillTrack}>
            <div className={styles.fillBar} style={{ width: `${Math.min(cell.loadPercent, 100)}%` }} />
          </div>
        </>
      )}
      {(hasLocked || hasLate) && (
        <span className={styles.cellFlags}>
          {hasLate && (
            <span title="Innehåller sena ordrar" role="img" aria-label="Innehåller sena ordrar">
              <Clock size={12} aria-hidden="true" />
            </span>
          )}
          {hasLocked && (
            <span title="Innehåller låsta operationer" role="img" aria-label="Innehåller låsta operationer">
              <Lock size={12} aria-hidden="true" />
            </span>
          )}
        </span>
      )}
    </>
  );
}

function CellView({
  cell,
  active = false,
  summa = false,
  onClick,
}: {
  cell: CapacityCell;
  active?: boolean;
  summa?: boolean;
  onClick?: () => void;
}) {
  const clickable = !!onClick;

  function onKeyDown(e: KeyboardEvent<HTMLDivElement>) {
    if (!onClick) return;
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      onClick();
    }
  }

  return (
    <div
      className={styles.cell}
      data-tone={toneFor(cell.loadPercent)}
      data-clickable={clickable}
      data-active={active}
      data-summa={summa}
      onClick={onClick}
      role={clickable ? "button" : undefined}
      tabIndex={clickable ? 0 : undefined}
      aria-expanded={clickable ? active : undefined}
      onKeyDown={clickable ? onKeyDown : undefined}
    >
      <CellContent cell={cell} flags={!summa} />
    </div>
  );
}

function ExpansionRow({
  label,
  orders,
  onMove,
}: {
  label: string;
  orders: CapacityCellOrder[];
  onMove?: (order: CapacityCellOrder) => void;
}) {
  return (
    <div className={styles.expansion}>
      {/* Sticky inside the horizontally scrolling matrix, so the list stays in
          view (and phone-wide) wherever the clicked cell was scrolled to. */}
      <div className={styles.expansionInner}>
        <div className={styles.expansionTitle}>{label}</div>
        {orders.map((o) => {
          const weeks = plannedWeekLabel(o.plannedStartWeek, o.plannedEndWeek);
          return (
            <div key={`${o.manufacturingOrderId}-${o.sequenceNo}`} className={styles.orderItem}>
              <div className={styles.orderMain}>
                <Link href={`/tillverkning/ordrar/${o.manufacturingOrderId}`} className={styles.rowLink}>
                  {o.orderNumber}
                </Link>
                <span>
                  {o.articleNumber} — {o.articleName}
                </span>
              </div>
              <div className={styles.orderMeta}>
                <span>Op {o.sequenceNo}</span>
                <span>
                  {formatHours(o.hoursInWeek)} h i veckan · {formatHours(o.remainingHours)} h kvar
                </span>
                <span>{weeks ?? "Ej planerad"}</span>
                <span>{o.dueDate ? `Färdigt ${o.dueDate}` : "—"}</span>
                {o.overdue && <StatusPill status="delayed" compact />}
                {o.late && <StatusPill status="delayed" label="Sen" compact />}
                {o.planLocked && (
                  <span className={styles.lockedBadge}>
                    <Lock size={12} aria-hidden="true" />
                    Låst
                  </span>
                )}
                {onMove && (
                  <Button type="button" variant="secondary" size="small" onClick={() => onMove(o)}>
                    Flytta…
                  </Button>
                )}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

type SummaryList = "overloaded" | "late" | "unplanned";

interface OverloadedCell {
  key: string;
  text: string;
}

// The overloaded week cells of the matrix, for the summary's list.
function overloadedCellList(data: CapacityResult): OverloadedCell[] {
  const multiYear = new Set(data.weeks.map((w) => w.isoYear)).size > 1;
  const out: OverloadedCell[] = [];
  for (const group of data.groups) {
    for (const resource of group.resources) {
      resource.weeks.forEach((cell, i) => {
        if (cell.loadPercent === null || cell.loadPercent <= 100) return;
        const week = data.weeks[i];
        if (!week) return;
        out.push({
          key: `${resource.workCenterId}:${week.monday}`,
          text: `${resource.code} · ${resource.name}, ${weekLabel(week, multiYear)} — ${cell.loadPercent}% (${formatHours(cell.loadHours)} av ${formatHours(cell.availableHours ?? 0)} h)`,
        });
      });
    }
  }
  return out;
}

// Last planned time and the three counts of the plan; each count unfolds its
// list (order numbers link to the order card).
function PlanSummary({
  summary,
  overloaded,
  open,
  onOpen,
}: {
  summary: CapacityResult["summary"];
  overloaded: OverloadedCell[];
  open: SummaryList | null;
  onOpen: (list: SummaryList) => void;
}) {
  const lateCount = summary.lateOrders.length;
  const unplannedCount = summary.unplannedOrders.length;
  const items: { list: SummaryList; count: number; text: string }[] = [
    {
      list: "overloaded",
      count: summary.overloadedCells,
      text: `${summary.overloadedCells} ${summary.overloadedCells === 1 ? "överbelagd cell" : "överbelagda celler"}`,
    },
    { list: "late", count: lateCount, text: `${lateCount} ${lateCount === 1 ? "sen order" : "sena ordrar"}` },
    {
      list: "unplanned",
      count: unplannedCount,
      text: `${unplannedCount} ej ${unplannedCount === 1 ? "planerad" : "planerade"}`,
    },
  ];
  return (
    <div className={styles.summary}>
      <div className={styles.summaryLine}>
        <span className={styles.plannedAt}>
          {summary.plannedAt ? `Senast planerad: ${formatStockholmDateTime(summary.plannedAt)}` : "Inte planerad ännu"}
        </span>
        <span className={styles.summaryCounts}>
          {items.map((item, i) => (
            <span key={item.list}>
              {i > 0 && " · "}
              {item.count > 0 ? (
                <button
                  type="button"
                  className={styles.linkButton}
                  aria-expanded={open === item.list}
                  onClick={() => onOpen(item.list)}
                >
                  {item.text}
                </button>
              ) : (
                item.text
              )}
            </span>
          ))}
        </span>
      </div>

      {open === "overloaded" && (
        <ul className={styles.summaryList}>
          {overloaded.length > 0 ? overloaded.map((c) => <li key={c.key}>{c.text}</li>) : <li>Se matrisen nedan.</li>}
        </ul>
      )}
      {open === "late" && (
        <ul className={styles.summaryList}>
          {summary.lateOrders.map((o) => (
            <li key={o.manufacturingOrderId}>
              <Link href={`/tillverkning/ordrar/${o.manufacturingOrderId}`} className={styles.rowLink}>
                {o.orderNumber}
              </Link>{" "}
              — färdigdatum {o.dueDate}, planerat klar {o.plannedFinish ?? "—"}
            </li>
          ))}
        </ul>
      )}
      {open === "unplanned" && (
        <ul className={styles.summaryList}>
          {summary.unplannedOrders.map((o) => (
            <li key={o.manufacturingOrderId}>
              <Link href={`/tillverkning/ordrar/${o.manufacturingOrderId}`} className={styles.rowLink}>
                {o.orderNumber}
              </Link>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

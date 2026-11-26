"use client";

import { useEffect, useRef, useState, type DragEvent, type KeyboardEvent } from "react";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { StatusPill } from "../ui/StatusPill";
import { Select } from "../ui/Field";
import { ListFilterSelect, useListNavigation } from "../ui/ListControls";
import { Button } from "../ui/Button";
import { FormError, FormHint, FormNotice } from "../ui/Form";
import { MoveOperationDialog, type MoveTarget } from "./MoveOperationDialog";
import { moveOperationTo, previewMove } from "./dayPlanWrites";
import { ArrowLeftRight, Clock, GripVertical, Lock } from "lucide-react";
import { ApiError, apiFetch } from "../../lib/api";
import {
  OTHER_RESOURCE_TEXT,
  draggableOrder,
  dropAllowed,
  dropDayText,
  moveBody,
  moveConfirmText,
  moveLabel,
  nextDropIndex,
  startIndex,
  type DropRefusal,
} from "../../lib/capacityDrag";
import { confirmDialog } from "../../lib/confirm";
import { apiErrorMessage } from "../../lib/errorMessages";
import { formatStockholmDateTime } from "../../lib/date";
import { plannedDateLabel, weekdayShortDate } from "../../lib/planning";
import { planSuggestionNotice, suggestionCountLabel, suggestionShift, suggestionText } from "../../lib/resourceSuggestion";
import { structureHref } from "../../lib/structureTree";
import { SwitchResourceButton } from "./SwitchResourceButton";
import { useCan } from "../PermissionsProvider";
import type {
  CapacityCell,
  CapacityCellOrder,
  CapacityDay,
  CapacityGroupBlock,
  CapacityResourceRow,
  CapacityResult,
  CapacityWeek,
  PlanResult,
  PlanWarning,
  ProductionGroup,
  ResourceSuggestionRow,
} from "../../lib/types";
import styles from "./BelaggningPageClient.module.css";

// Byt till X: who may switch (Tillverkning, like Flytta/Planera) and what to do
// after a switch. Threaded to the expansion rows and the lists.
interface SwitchHandlers {
  canSwitch: boolean;
  onSwitched: (moOperationId: string) => void;
  onError: (message: string | null) => void;
}

// Dra en operation till en annan dag (day view only, S34). One operation is
// "in the air" at a time: dragged with the mouse from its grip, or lifted
// with the keyboard (the grip is a button) and steered with ←/→. `target` is
// the day cell the drop would land on.
interface ActiveMove {
  order: CapacityCellOrder;
  // The resource the operation is on — a move never changes it.
  workCenterId: string;
  keys: boolean;
  target: { workCenterId: string; date: string } | null;
}

interface MoveDrag {
  canPlan: boolean;
  // Grips are drawn: Tillverkning, the day view and a fine pointer.
  canDrag: boolean;
  // …and usable: no read and no write is running.
  ready: boolean;
  days: CapacityDay[];
  active: ActiveMove | null;
  onDragStart: (order: CapacityCellOrder, workCenterId: string) => void;
  onDragEnd: () => void;
  onOver: (workCenterId: string, date: string) => void;
  onLeave: (workCenterId: string, date: string) => void;
  onDrop: (resource: CapacityResourceRow, date: string) => void;
  // The grip pressed (Enter/space/click): lift the operation, or — already
  // lifted — drop it on the chosen day.
  onGrip: (order: CapacityCellOrder, resource: CapacityResourceRow) => void;
  onStep: (resource: CapacityResourceRow, step: -1 | 1) => void;
  onCancel: () => void;
}

const WEEK_OPTIONS = [4, 8, 13, 26];
const DEFAULT_WEEKS = 8;
const DAY_OPTIONS = [7, 14, 28];
const DEFAULT_DAYS = 14;

// Red is the API's `overloaded` flag (over 100 %, or load in a week whose
// schedule gives 0 h — that one has no percentage), never re-derived here.
function toneFor(cell: CapacityCell): "neutral" | "warn" | "alert" {
  if (cell.overloaded) return "alert";
  if (cell.loadPercent !== null && cell.loadPercent > 85) return "warn";
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

// Day view column: "mån 16 nov", with the ISO week number on Mondays and the
// first column.
function dayLabel(day: CapacityDay, index: number): { title: string; week: string | null } {
  return { title: weekdayShortDate(day.date), week: day.weekday === 1 || index === 0 ? `v.${day.isoWeek}` : null };
}

// Which cell is currently expanded (drill-down row shown right under its
// resource). Carries the cell's own data — no re-fetch needed to render it.
interface ExpandedCell {
  key: string;
  workCenterId: string;
  label: string;
  cell: CapacityCell;
  // The matrix the cell was clicked in (viewOf). `col:3` is week 3 in one
  // view and day 3 in another, so an expansion never survives a change of it.
  view: string;
}

// The identity of a matrix's columns: Vecka/Dag and how many of them.
function viewOf(res: CapacityResult): string {
  return `${res.granularity}:${res.granularity === "day" ? res.days.length : res.weeks.length}`;
}

function cellsOf(resource: CapacityResourceRow, granularity: "week" | "day"): CapacityCell[] {
  return granularity === "day" ? resource.days : resource.weeks;
}

// After a reload (Flytta…/Lås upp): the expansion stays when its cell still
// holds orders, with the fresh cell data; otherwise it closes. Another view
// (Vecka ↔ Dag, another number of columns) always closes it — also a cell
// clicked in the old matrix while the new view was still loading.
function refreshExpanded(prev: ExpandedCell | null, res: CapacityResult): ExpandedCell | null {
  if (!prev || prev.view !== viewOf(res)) return null;
  const colKey = prev.key.slice(prev.workCenterId.length + 1);
  for (const group of res.groups) {
    const resource = group.resources.find((r) => r.workCenterId === prev.workCenterId);
    if (!resource) continue;
    const cell = colKey.startsWith("col:")
      ? cellsOf(resource, res.granularity)[Number(colKey.slice(4))]
      : colKey === "later"
        ? resource.later
        : resource.undated;
    return cell && cell.orders.length > 0 ? { ...prev, cell } : null;
  }
  return null;
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
  const [switchError, setSwitchError] = useState<string | null>(null);
  // Dra till en annan dag: the mouse only (a touch screen has Flytta…).
  const [finePointer, setFinePointer] = useState(false);
  const [activeMove, setActiveMove] = useState<ActiveMove | null>(null);
  const [moveBusy, setMoveBusy] = useState(false);
  const [moveError, setMoveError] = useState<string | null>(null);
  const [moveNotice, setMoveNotice] = useState<{ title: string; warnings: PlanWarning[] } | null>(null);

  useEffect(() => {
    apiFetch<ProductionGroup[]>("/api/v1/production-groups").then(setGroups).catch(() => setGroups([]));
  }, []);

  useEffect(() => {
    const query = window.matchMedia("(pointer: fine)");
    const update = () => setFinePointer(query.matches);
    update();
    query.addEventListener("change", update);
    return () => query.removeEventListener("change", update);
  }, []);

  const weeksRaw = Number(searchParams.get("weeks"));
  const weeks = WEEK_OPTIONS.includes(weeksRaw) ? weeksRaw : DEFAULT_WEEKS;
  const productionGroupId = searchParams.get("productionGroupId") ?? "";
  const dayView = searchParams.get("vy") === "dag";
  const daysRaw = Number(searchParams.get("days"));
  const days = DAY_OPTIONS.includes(daysRaw) ? daysRaw : DEFAULT_DAYS;

  // A changed filter/horizon closes the expansion; a plain reload (reloadTick)
  // keeps it, see refreshExpanded.
  const lastQueryKey = useRef(queryKey);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setLoadError(null);
    if (lastQueryKey.current !== queryKey) {
      lastQueryKey.current = queryKey;
      setExpanded(null);
    }
    const qs = dayView
      ? new URLSearchParams({ granularity: "day", days: String(days) })
      : new URLSearchParams({ weeks: String(weeks) });
    if (productionGroupId) qs.set("productionGroupId", productionGroupId);
    apiFetch<CapacityResult>(`/api/v1/planning/capacity?${qs.toString()}`)
      .then((res) => {
        if (cancelled) return;
        setData(res);
        setExpanded((prev) => refreshExpanded(prev, res));
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        setData(null);
        setLoadError(apiErrorMessage(err, "Kunde inte läsa beläggningen."));
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
      "Planera om alla öppna tillverkningsordrar på ledig kapacitet? Operationer som flyttats för hand ligger kvar.",
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
    if (!data) return;
    const view = viewOf(data);
    setExpanded((prev) => (prev?.key === key ? null : { key, workCenterId: resource.workCenterId, label, cell, view }));
  }

  function openMove(resource: CapacityResourceRow, order: CapacityCellOrder) {
    setMoveTarget({ order, resource });
  }

  // A drop (mouse or keyboard) on a day of the operation's own resource: the
  // API's preview first, then the question with what it said, then the move.
  // Nothing is written before the answer; a refusal in the preview (a day
  // without capacity, moved since the matrix was read …) is shown as it is.
  async function moveByDrop(order: CapacityCellOrder, date: string, refocus: boolean) {
    if (!canPlan || moveBusy) return;
    const body = moveBody(order, date);
    setMoveError(null);
    setMoveNotice(null);
    setMoveBusy(true);
    try {
      const preview = await previewMove(order.moOperationId, body);
      const ok = await confirmDialog(moveConfirmText(order, date, preview), { confirmLabel: "Flytta" });
      if (!ok) return;
      const res = await moveOperationTo(order.moOperationId, body.date, body.expectedStartDate);
      // The Planera result no longer describes the plan.
      setPlanResult(null);
      setMoveNotice({
        title: `Op ${order.sequenceNo} på ${order.orderNumber} är flyttad till ${weekdayShortDate(date)} och låst.`,
        warnings: res.warnings,
      });
      setReloadTick((n) => n + 1);
    } catch (err) {
      setMoveError(apiErrorMessage(err, "Kunde inte flytta operationen"));
      // Moved by someone else since the matrix was read: show it as it is.
      if (err instanceof ApiError && err.code === "operation-plan-changed") setReloadTick((n) => n + 1);
    } finally {
      setMoveBusy(false);
      // The keyboard's way back: the grip of the row, when it is still there.
      if (refocus) window.setTimeout(() => document.querySelector<HTMLElement>(`[data-grip="${order.moOperationId}"]`)?.focus(), 0);
    }
  }

  function dayTarget(resource: CapacityResourceRow, date: string) {
    const load = resource.dayLoads.find((d) => d.date === date);
    return { kind: "day" as const, workCenterId: resource.workCenterId, date, availableHours: load ? load.availableHours : null };
  }

  const dataDays = data?.granularity === "day" ? data.days : [];
  const canDrag = canPlan && data?.granularity === "day" && finePointer;
  const moveReady = canDrag && !loading && !moveBusy && !planBusy;

  // No move survives a read or a write: the grip is disabled meanwhile, so
  // its dragend might never clear the marks.
  useEffect(() => {
    if (!moveReady) setActiveMove(null);
  }, [moveReady]);

  const moveDrag: MoveDrag = {
    canPlan,
    canDrag,
    ready: moveReady,
    days: dataDays,
    active: activeMove,
    onDragStart: (order, workCenterId) => {
      if (!moveReady) return;
      setMoveError(null);
      setActiveMove({ order, workCenterId, keys: false, target: null });
    },
    onDragEnd: () => setActiveMove(null),
    onOver: (workCenterId, date) =>
      setActiveMove((prev) =>
        !prev || (prev.target?.workCenterId === workCenterId && prev.target.date === date) ? prev : { ...prev, target: { workCenterId, date } }
      ),
    onLeave: (workCenterId, date) =>
      setActiveMove((prev) =>
        prev && !prev.keys && prev.target?.workCenterId === workCenterId && prev.target.date === date ? { ...prev, target: null } : prev
      ),
    onDrop: (resource, date) => {
      const move = activeMove;
      setActiveMove(null);
      if (!move || !moveReady) return;
      const verdict = dropAllowed(move.order, move.workCenterId, dayTarget(resource, date));
      if (verdict.ok) void moveByDrop(move.order, date, false);
      else if (verdict.reason === "other_resource") setMoveError(OTHER_RESOURCE_TEXT);
    },
    onGrip: (order, resource) => {
      if (!moveReady) return;
      const move = activeMove;
      if (!move || !move.keys || move.order.moOperationId !== order.moOperationId) {
        setMoveError(null);
        setActiveMove({ order, workCenterId: resource.workCenterId, keys: true, target: null });
        return;
      }
      setActiveMove(null);
      if (!move.target) return;
      if (dropAllowed(order, move.workCenterId, dayTarget(resource, move.target.date)).ok) void moveByDrop(order, move.target.date, true);
    },
    onStep: (resource, step) =>
      setActiveMove((prev) => {
        if (!prev || !prev.keys) return prev;
        const from = prev.target ? dataDays.findIndex((d) => d.date === prev.target!.date) : startIndex(dataDays, prev.order);
        const day = dataDays[nextDropIndex(dataDays, resource.dayLoads, from, step)];
        return day ? { ...prev, target: { workCenterId: resource.workCenterId, date: day.date } } : prev;
      }),
    onCancel: () => setActiveMove(null),
  };

  // After Byt till X the operation is Vald för hand and its förslag is gone:
  // drop it from Planera's notice and reload the matrix.
  const switchHandlers: SwitchHandlers = {
    canSwitch: canPlan,
    onSwitched: (moOperationId) => {
      setPlanResult((prev) =>
        prev ? { ...prev, resourceSuggestions: prev.resourceSuggestions.filter((r) => r.moOperationId !== moOperationId) } : prev
      );
      setReloadTick((n) => n + 1);
    },
    onError: setSwitchError,
  };

  const overloadedList = data ? overloadedCellList(data) : [];
  const spansMultipleYears = data ? new Set(data.weeks.map((w) => w.isoYear)).size > 1 : false;
  // The loaded data decides the layout (a view switch shows the old matrix
  // until the new one lands).
  const dataIsDay = data?.granularity === "day";
  const columnCount = data ? (dataIsDay ? data.days.length : data.weeks.length) : 0;
  const gridTemplateColumns = data ? `220px repeat(${columnCount + 2}, minmax(${dataIsDay ? 84 : 96}px, 1fr))` : undefined;
  const columnLabels: string[] = data
    ? dataIsDay
      ? data.days.map((d) => weekdayShortDate(d.date))
      : data.weeks.map((w) => weekLabel(w, spansMultipleYears))
    : [];

  return (
    <>
      <div className={styles.toolbar}>
        <ListFilterSelect
          param="productionGroupId"
          allLabel="Alla produktionsgrupper"
          ariaLabel="Filtrera på produktionsgrupp"
          options={groups.map((g) => ({ value: g.id, label: `${g.code} · ${g.name}` }))}
        />
        <div className={styles.viewToggle} role="group" aria-label="Vy">
          <button type="button" className={styles.viewButton} aria-pressed={!dayView} onClick={() => setFilter("vy", null)}>
            Vecka
          </button>
          <button type="button" className={styles.viewButton} aria-pressed={dayView} onClick={() => setFilter("vy", "dag")}>
            Dag
          </button>
        </div>
        {dayView ? (
          <>
            <label htmlFor="daysSelect" style={{ fontSize: 13, color: "var(--color-text-secondary)" }}>
              Dagar
            </label>
            <Select
              id="daysSelect"
              size="xs"
              value={String(days)}
              onChange={(e) => setFilter("days", Number(e.target.value) === DEFAULT_DAYS ? null : e.target.value)}
              aria-label="Antal dagar"
            >
              {DAY_OPTIONS.map((d) => (
                <option key={d} value={d}>
                  {d}
                </option>
              ))}
            </Select>
          </>
        ) : (
          <>
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
          </>
        )}
        {canPlan && (
          <Button type="button" variant="primary" size="small" disabled={planBusy} onClick={runPlan}>
            {planBusy ? "Planerar…" : "Planera"}
          </Button>
        )}
      </div>

      <FormError margin="below">{loadError}</FormError>
      <FormError margin="below">{planError}</FormError>
      <FormError margin="below">{switchError}</FormError>
      <FormError margin="below">{moveError}</FormError>
      {moveNotice && (
        <FormNotice className={styles.planNotice}>
          <div>{moveNotice.title}</div>
          {moveNotice.warnings.length > 0 && (
            <ul className={styles.warningList}>
              {moveNotice.warnings.map((w, i) => (
                <li key={i}>
                  <WarningLine warning={w} />
                </li>
              ))}
            </ul>
          )}
        </FormNotice>
      )}
      {loading && data && <FormHint>Uppdaterar…</FormHint>}

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
                  <WarningLine warning={w} />
                </li>
              ))}
            </ul>
          )}
          {!showAllWarnings && planResult.warnings.length > 10 && (
            <button type="button" className={styles.noticeButton} onClick={() => setShowAllWarnings(true)}>
              Visa alla ({planResult.warnings.length})
            </button>
          )}
          {planResult.resourceSuggestions.length > 0 && (
            <>
              <div className={styles.noticeSection}>{planSuggestionNotice(planResult.resourceSuggestions.length)}:</div>
              <ul className={styles.warningList}>
                {planResult.resourceSuggestions.map((r) => (
                  <li key={r.moOperationId}>
                    <SuggestionLine row={r} handlers={switchHandlers} />
                  </li>
                ))}
              </ul>
            </>
          )}
        </FormNotice>
      )}

      {data && (
        <PlanSummary
          summary={data.summary}
          granularity={data.granularity}
          overloaded={overloadedList}
          open={summaryList}
          onOpen={(list) => setSummaryList((prev) => (prev === list ? null : list))}
          switchHandlers={switchHandlers}
        />
      )}

      {!loading && data && data.groups.length === 0 && <p>Inga släppta tillverkningsordrar med återstående tid.</p>}

      {data && data.groups.length > 0 && (
        <div className={styles.scroller}>
          <div className={styles.grid} style={{ gridTemplateColumns }}>
            <div className={styles.headerLabel}>Resurs</div>
            {dataIsDay
              ? data.days.map((d, i) => {
                  const l = dayLabel(d, i);
                  return (
                    <div key={i} className={styles.headerCell}>
                      {l.week && <span className={styles.headerWeek}>{l.week}</span>}
                      {l.title}
                    </div>
                  );
                })
              : data.weeks.map((w, i) => (
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
                granularity={data.granularity}
                columnLabels={columnLabels}
                expanded={expanded}
                onCellClick={toggleCell}
                canMove={canPlan}
                onMove={openMove}
                switchHandlers={switchHandlers}
                moveDrag={moveDrag}
              />
            ))}
          </div>
        </div>
      )}

      <MoveOperationDialog
        target={moveTarget}
        today={data?.today ?? null}
        onClose={() => setMoveTarget(null)}
        onChanged={() => {
          // The Planera result no longer describes the plan.
          setPlanResult(null);
          setReloadTick((n) => n + 1);
        }}
      />
    </>
  );
}

function GroupBlock({
  group,
  granularity,
  columnLabels,
  expanded,
  onCellClick,
  canMove,
  onMove,
  switchHandlers,
  moveDrag,
}: {
  group: CapacityGroupBlock;
  granularity: "week" | "day";
  columnLabels: string[];
  expanded: ExpandedCell | null;
  onCellClick: (resource: CapacityResourceRow, colKey: string, label: string, cell: CapacityCell) => void;
  canMove: boolean;
  onMove: (resource: CapacityResourceRow, order: CapacityCellOrder) => void;
  switchHandlers: SwitchHandlers;
  moveDrag: MoveDrag;
}) {
  return (
    <>
      <div className={styles.groupHeader}>{group.code ? `${group.code} · ${group.name}` : group.name}</div>

      {group.resources.map((resource) => (
        <ResourceBlock
          key={resource.workCenterId}
          resource={resource}
          granularity={granularity}
          columnLabels={columnLabels}
          expanded={expanded}
          onCellClick={onCellClick}
          canMove={canMove}
          onMove={onMove}
          switchHandlers={switchHandlers}
          moveDrag={moveDrag}
        />
      ))}

      <div className={styles.resourceLabel} data-summa="true">
        Summa
      </div>
      {(granularity === "day" ? group.dayTotals : group.weekTotals).map((cell, i) => (
        <CellView key={i} cell={cell} summa granularity={granularity} />
      ))}
      <CellView cell={group.laterTotal} summa granularity={granularity} />
      <CellView cell={group.undatedTotal} summa granularity={granularity} />
    </>
  );
}

function ResourceBlock({
  resource,
  granularity,
  columnLabels,
  expanded,
  onCellClick,
  canMove,
  onMove,
  switchHandlers,
  moveDrag,
}: {
  resource: CapacityResourceRow;
  granularity: "week" | "day";
  columnLabels: string[];
  expanded: ExpandedCell | null;
  onCellClick: (resource: CapacityResourceRow, colKey: string, label: string, cell: CapacityCell) => void;
  canMove: boolean;
  onMove: (resource: CapacityResourceRow, order: CapacityCellOrder) => void;
  switchHandlers: SwitchHandlers;
  moveDrag: MoveDrag;
}) {
  const isExpandedHere = expanded?.workCenterId === resource.workCenterId;
  const active = moveDrag.active;

  // A day cell as a drop target while an operation is in the air. Only the
  // day cells get one — Senare, Odaterat and the Summa row never take a drop.
  function dropFor(date: string | undefined): CellDrop | undefined {
    if (!active || !date) return undefined;
    const load = resource.dayLoads.find((d) => d.date === date);
    const verdict = dropAllowed(active.order, active.workCenterId, {
      kind: "day",
      workCenterId: resource.workCenterId,
      date,
      availableHours: load ? load.availableHours : null,
    });
    return {
      state: verdict.ok ? "ok" : verdict.reason,
      over: active.target?.workCenterId === resource.workCenterId && active.target.date === date,
      onOver: () => moveDrag.onOver(resource.workCenterId, date),
      onLeave: () => moveDrag.onLeave(resource.workCenterId, date),
      onDrop: () => moveDrag.onDrop(resource, date),
    };
  }

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

      {cellsOf(resource, granularity).map((cell, i) => {
        const key = `col:${i}`;
        const label = columnLabels[i] ?? "";
        return (
          <CellView
            key={i}
            cell={cell}
            granularity={granularity}
            active={expanded?.key === `${resource.workCenterId}:${key}`}
            onClick={cell.orders.length > 0 ? () => onCellClick(resource, key, label, cell) : undefined}
            drop={granularity === "day" ? dropFor(moveDrag.days[i]?.date) : undefined}
          />
        );
      })}
      <CellView
        cell={resource.later}
        granularity={granularity}
        active={expanded?.key === `${resource.workCenterId}:later`}
        onClick={resource.later.orders.length > 0 ? () => onCellClick(resource, "later", "Senare", resource.later) : undefined}
      />
      <CellView
        cell={resource.undated}
        granularity={granularity}
        active={expanded?.key === `${resource.workCenterId}:undated`}
        onClick={
          resource.undated.orders.length > 0
            ? () => onCellClick(resource, "undated", "Odaterat", resource.undated)
            : undefined
        }
      />

      {isExpandedHere && expanded && (
        <ExpansionRow
          workCenterId={resource.workCenterId}
          label={`${resource.code} · ${resource.name} — ${expanded.label}`}
          orders={expanded.cell.orders}
          granularity={granularity}
          onMove={canMove ? (order) => onMove(resource, order) : undefined}
          switchHandlers={switchHandlers}
          resource={resource}
          moveDrag={moveDrag}
        />
      )}
    </>
  );
}

function CellContent({ cell, flags = true, granularity }: { cell: CapacityCell; flags?: boolean; granularity: "week" | "day" }) {
  const hasLocked = flags && cell.orders.some((o) => o.planLocked);
  const hasLate = flags && cell.orders.some((o) => o.late);
  const hasSuggestion = flags && cell.orders.some((o) => o.suggestion !== null);
  return (
    <>
      <span className={styles.cellHours}>
        {formatHours(cell.loadHours)}
        {cell.availableHours !== null && ` / ${formatHours(cell.availableHours)}`}
      </span>
      {/* Load in a week with 0 h capacity: no percentage exists, so say why
          the cell is red instead of leaving the slot empty. */}
      {cell.loadPercent === null && cell.overloaded && <span className={styles.cellPercent}>Ingen kapacitet</span>}
      {cell.loadPercent !== null && (
        <>
          <span className={styles.cellPercent}>{cell.loadPercent}%</span>
          <div className={styles.fillTrack}>
            <div className={styles.fillBar} style={{ width: `${Math.min(cell.loadPercent, 100)}%` }} />
          </div>
        </>
      )}
      {granularity === "week" && cell.overloadedDays > 0 && (
        <span className={styles.overloadedDays}>
          {cell.overloadedDays === 1 ? "1 dag överbelagd" : `${cell.overloadedDays} dagar överbelagda`}
        </span>
      )}
      {(hasLocked || hasLate || hasSuggestion) && (
        <span className={styles.cellFlags}>
          {hasSuggestion && (
            <span title="Innehåller operationer med förslag på alternativ resurs" role="img" aria-label="Innehåller förslag på alternativ resurs">
              <ArrowLeftRight size={12} aria-hidden="true" />
            </span>
          )}
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

// A day cell while an operation is dragged or lifted: what a drop here would
// be (capacityDrag's dropAllowed) and whether it is the current target.
interface CellDrop {
  state: "ok" | DropRefusal;
  over: boolean;
  onOver: () => void;
  onLeave: () => void;
  onDrop: () => void;
}

function CellView({
  cell,
  active = false,
  summa = false,
  granularity,
  onClick,
  drop,
}: {
  cell: CapacityCell;
  granularity: "week" | "day";
  active?: boolean;
  summa?: boolean;
  onClick?: () => void;
  drop?: CellDrop;
}) {
  const clickable = !!onClick;
  const ref = useRef<HTMLDivElement>(null);
  const over = drop?.over ?? false;

  // The keyboard's target may be scrolled out of the matrix.
  useEffect(() => {
    if (over) ref.current?.scrollIntoView({ block: "nearest", inline: "nearest" });
  }, [over]);

  function onDragOver(e: DragEvent<HTMLDivElement>) {
    if (!drop) return;
    if (drop.state === "ok" || drop.state === "other_resource") {
      // Another resource takes the drop only to say why not (S34): the page
      // answers "Byt resurs görs på TO-kortet" and writes nothing.
      e.preventDefault();
      e.dataTransfer.dropEffect = "move";
      drop.onOver();
      return;
    }
    // No capacity that day (or the operation's own day): no drop at all.
    e.dataTransfer.dropEffect = "none";
  }

  function onDrop(e: DragEvent<HTMLDivElement>) {
    if (!drop) return;
    e.preventDefault();
    drop.onDrop();
  }

  function onKeyDown(e: KeyboardEvent<HTMLDivElement>) {
    if (!onClick) return;
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      onClick();
    }
  }

  return (
    <div
      ref={ref}
      className={styles.cell}
      data-drop={drop?.state}
      data-drop-over={drop ? over : undefined}
      onDragOver={drop ? onDragOver : undefined}
      onDragLeave={
        drop
          ? (e) => {
              if (!(e.relatedTarget instanceof Node) || !e.currentTarget.contains(e.relatedTarget)) drop.onLeave();
            }
          : undefined
      }
      onDrop={drop ? onDrop : undefined}
      data-tone={toneFor(cell)}
      data-clickable={clickable}
      data-active={active}
      data-summa={summa}
      onClick={onClick}
      role={clickable ? "button" : undefined}
      tabIndex={clickable ? 0 : undefined}
      aria-expanded={clickable ? active : undefined}
      onKeyDown={clickable ? onKeyDown : undefined}
    >
      <CellContent cell={cell} flags={!summa} granularity={granularity} />
      {/* Why this day takes no drop — unless the cell already says so. */}
      {drop?.state === "no_capacity" && !(cell.loadPercent === null && cell.overloaded) && (
        <span className={styles.dropLabel}>ingen kapacitet</span>
      )}
      {drop?.state === "other_resource" && over && <span className={styles.dropLabel}>annan resurs</span>}
    </div>
  );
}

function ExpansionRow({
  workCenterId,
  label,
  orders,
  granularity,
  onMove,
  switchHandlers,
  resource,
  moveDrag,
}: {
  // The expanded resource — every order in its cells is an operation on it
  // (the förslag's "from", sent as Byt till's precondition).
  workCenterId: string;
  label: string;
  orders: CapacityCellOrder[];
  granularity: "week" | "day";
  onMove?: (order: CapacityCellOrder) => void;
  switchHandlers: SwitchHandlers;
  resource: CapacityResourceRow;
  moveDrag: MoveDrag;
}) {
  // The operation lifted with the keyboard on this resource, and where it
  // would land — read out as the target moves.
  const lifted = moveDrag.active?.keys && moveDrag.active.workCenterId === workCenterId ? moveDrag.active : null;
  const liftedText = lifted
    ? lifted.target
      ? `${dropDayText(lifted.target.date, resource.dayLoads.find((d) => d.date === lifted.target!.date))} · Enter flyttar, Esc avbryter`
      : `Op ${lifted.order.sequenceNo} på ${lifted.order.orderNumber}: välj dag med ← och →, Enter flyttar, Esc avbryter`
    : "";

  function onGripKeyDown(e: KeyboardEvent<HTMLButtonElement>) {
    if (!lifted) return;
    if (e.key === "ArrowLeft" || e.key === "ArrowRight") {
      e.preventDefault();
      moveDrag.onStep(resource, e.key === "ArrowLeft" ? -1 : 1);
    } else if (e.key === "Escape") {
      e.preventDefault();
      moveDrag.onCancel();
    }
  }

  return (
    <div className={styles.expansion}>
      {/* Sticky inside the horizontally scrolling matrix, so the list stays in
          view (and phone-wide) wherever the clicked cell was scrolled to. */}
      <div className={styles.expansionInner}>
        <div className={styles.expansionTitle}>{label}</div>
        {moveDrag.canDrag && (
          <div className={styles.liftHint} aria-live="polite">
            {liftedText}
          </div>
        )}
        {orders.map((o) => {
          const dates = plannedDateLabel(o.plannedStartDate, o.plannedEndDate);
          const isLifted = lifted?.order.moOperationId === o.moOperationId;
          return (
            <div
              key={`${o.manufacturingOrderId}-${o.sequenceNo}`}
              className={styles.orderItem}
              data-moving={moveDrag.active?.order.moOperationId === o.moOperationId}
            >
              <div className={styles.orderMain}>
                {/* Dra till en annan dag: a mouse drags the grip; the keyboard
                    presses it, steers with ←/→ and presses again. */}
                {moveDrag.canDrag && draggableOrder(o, granularity, moveDrag.canPlan) && (
                  <button
                    type="button"
                    className={styles.grip}
                    data-grip={o.moOperationId}
                    draggable={moveDrag.ready}
                    aria-disabled={!moveDrag.ready}
                    aria-pressed={isLifted}
                    aria-label={`${moveLabel(o)} med piltangenterna`}
                    title="Dra till en annan dag — eller tryck Enter och välj dag med piltangenterna"
                    onClick={() => moveDrag.onGrip(o, resource)}
                    onKeyDown={onGripKeyDown}
                    onBlur={() => {
                      if (isLifted) moveDrag.onCancel();
                    }}
                    onDragStart={(e) => {
                      e.dataTransfer.effectAllowed = "move";
                      e.dataTransfer.setData("text/plain", o.moOperationId);
                      const row = e.currentTarget.closest(`.${styles.orderItem}`);
                      if (row) e.dataTransfer.setDragImage(row, 16, 16);
                      moveDrag.onDragStart(o, workCenterId);
                    }}
                    onDragEnd={moveDrag.onDragEnd}
                  >
                    <GripVertical size={16} aria-hidden="true" />
                  </button>
                )}
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
                  {granularity === "day" && o.hoursInDay !== null ? `${formatHours(o.hoursInDay)} h i dagen` : `${formatHours(o.hoursInWeek)} h i veckan`} · {formatHours(o.remainingHours)} h kvar
                </span>
                <span>{dates ?? "Ej planerad"}</span>
                <span>{o.dueDate ? `Färdigt ${o.dueDate}` : "—"}</span>
                {o.overdue && <StatusPill status="delayed" compact />}
                {o.late && <StatusPill status="delayed" label="Sen" compact />}
                {o.componentLate && (
                  <span title="En halvfabrikat-TO som ordern behöver blir klar efter behovet">
                    <StatusPill status="delayed" label="Halvfabrikat sent" compact />
                  </span>
                )}
                {o.planLocked && (
                  <span className={styles.lockedBadge}>
                    <Lock size={12} aria-hidden="true" />
                    Låst
                  </span>
                )}
                {o.ordinaryWorkCenterCode !== null && (
                  <span title={`Ordinarie: ${o.ordinaryWorkCenterCode}`}>
                    <StatusPill status="running" label={`Alternativ (för ${o.ordinaryWorkCenterCode})`} compact />
                  </span>
                )}
                {o.resourceLocked && (
                  <span title="Resursen är vald för hand — Planeringen föreslår inget byte">
                    <StatusPill status="draft" label="Vald för hand" compact />
                  </span>
                )}
                {onMove && (
                  <Button type="button" variant="secondary" size="small" onClick={() => onMove(o)}>
                    Flytta…
                  </Button>
                )}
                <Link href={structureHref({ to: o.manufacturingOrderId })} className={styles.structureLink}>
                  Visa strukturen
                </Link>
              </div>
              {o.suggestion && (
                <div className={styles.suggestionLine}>
                  <StatusPill status="delayed" label={`Förslag: ${o.suggestion.code}`} compact />
                  <span>{suggestionText(o.suggestion)}</span>
                  {switchHandlers.canSwitch && (
                    <SwitchResourceButton
                      manufacturingOrderId={o.manufacturingOrderId}
                      moOperationId={o.moOperationId}
                      fromWorkCenterId={workCenterId}
                      workCenterId={o.suggestion.workCenterId}
                      code={o.suggestion.code}
                      onSwitched={() => switchHandlers.onSwitched(o.moOperationId)}
                      onError={switchHandlers.onError}
                    />
                  )}
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

// A warning line led by its order number as a link. Some messages already
// start with the number ("TO-123 blir klar …") — then that number is the link
// and is not repeated.
function WarningLine({ warning }: { warning: PlanWarning }) {
  const href = `/tillverkning/ordrar/${warning.manufacturingOrderId}`;
  if (warning.message.startsWith(warning.orderNumber)) {
    return (
      <>
        <Link href={href} className={styles.noticeLink}>
          {warning.orderNumber}
        </Link>
        {warning.message.slice(warning.orderNumber.length)}
      </>
    );
  }
  return (
    <>
      <Link href={href} className={styles.noticeLink}>
        {warning.orderNumber}
      </Link>
      : {warning.message}
    </>
  );
}

// One förslag as a list row: order link, Op, "110 → 120, v.49 → v.47" and Byt till X.
function SuggestionLine({ row, handlers }: { row: ResourceSuggestionRow; handlers: SwitchHandlers }) {
  return (
    <span className={styles.suggestionRow}>
      <span>
        <Link href={`/tillverkning/ordrar/${row.manufacturingOrderId}`} className={styles.noticeLink}>
          {row.orderNumber}
        </Link>{" "}
        op {row.sequenceNo}: {suggestionShift({ ...row, code: row.toCode })}
      </span>
      {handlers.canSwitch && (
        <SwitchResourceButton
          manufacturingOrderId={row.manufacturingOrderId}
          moOperationId={row.moOperationId}
          fromWorkCenterId={row.fromWorkCenterId}
          workCenterId={row.toWorkCenterId}
          code={row.toCode}
          onSwitched={() => handlers.onSwitched(row.moOperationId)}
          onError={handlers.onError}
        />
      )}
    </span>
  );
}

type SummaryList = "overloaded" | "late" | "unplanned" | "suggestions";

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
      cellsOf(resource, data.granularity).forEach((cell, i) => {
        if (!cell.overloaded) return;
        const day = data.days[i];
        const week = data.weeks[i];
        const label = data.granularity === "day" ? (day ? weekdayShortDate(day.date) : null) : week ? weekLabel(week, multiYear) : null;
        if (label === null) return;
        out.push({
          key: `${resource.workCenterId}:${day?.date ?? week?.monday}`,
          text: `${resource.code} · ${resource.name}, ${label} — ${cell.loadPercent === null ? "ingen kapacitet" : `${cell.loadPercent}%`} (${formatHours(cell.loadHours)} av ${formatHours(cell.availableHours ?? 0)} h)`,
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
  granularity,
  overloaded,
  open,
  onOpen,
  switchHandlers,
}: {
  summary: CapacityResult["summary"];
  granularity: "week" | "day";
  overloaded: OverloadedCell[];
  open: SummaryList | null;
  onOpen: (list: SummaryList) => void;
  switchHandlers: SwitchHandlers;
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
  // Alternativa resurser: only shown when there is something to suggest.
  const suggestionCount = summary.resourceSuggestions.length;
  if (suggestionCount > 0) {
    items.push({ list: "suggestions", count: suggestionCount, text: suggestionCountLabel(suggestionCount) });
  }
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
          {summary.lockedOperations > 0 && (
            <span title="Operationer som flyttats för hand ligger kvar när du planerar">
              {" · "}
              {summary.lockedOperations === 1 ? "1 låst operation" : `${summary.lockedOperations} låsta operationer`}
            </span>
          )}
          {granularity === "week" && summary.overloadedDays > 0 && (
            <span>
              {" · "}
              {summary.overloadedDays === 1 ? "1 överbelagd dag" : `${summary.overloadedDays} överbelagda dagar`}
            </span>
          )}
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
      {open === "suggestions" && (
        <ul className={styles.summaryList}>
          {summary.resourceSuggestions.map((r) => (
            <li key={r.moOperationId}>
              <SuggestionLine row={r} handlers={switchHandlers} />
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

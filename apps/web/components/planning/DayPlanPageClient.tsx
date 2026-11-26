"use client";

import Link from "next/link";
import { useCallback, useEffect, useMemo, useRef, useState, type DragEvent } from "react";
import { ArrowDown, ArrowUp, ChevronLeft, ChevronRight, GripVertical, Maximize, Minimize, Presentation, X } from "lucide-react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { ApiError, apiFetch } from "../../lib/api";
import { confirmDialog } from "../../lib/confirm";
import { runPlanView, type RunPlanView } from "../../lib/coRun";
import {
  RUN_PLAN_STATUS_PILL,
  dayPlanHref,
  dropIndex,
  loadPercent,
  loadText,
  moveTargetOf,
  reorderIds,
  reorderableIds,
  runPlanStatusText,
  splitResources,
  stampText,
} from "../../lib/dayPlan";
import { formatStockholmDate } from "../../lib/date";
import { apiErrorMessage } from "../../lib/errorMessages";
import { formatQuantity } from "../../lib/format";
import { plannedDateLabel, weekdayShortDate } from "../../lib/planning";
import type { DayPlanResource, DayPlanResult, RunPlanRow } from "../../lib/types";
import { PrintButton } from "../documents/PrintButton";
import { useCan } from "../PermissionsProvider";
import { Button } from "../ui/Button";
import buttonStyles from "../ui/Button.module.css";
import { Select } from "../ui/Field";
import { FormError, FormHint, FormNotice } from "../ui/Form";
import { GatedLink } from "../ui/GatedLink";
import { RowMenu } from "../ui/RowMenu";
import { SegmentedToggle } from "../ui/SegmentedToggle";
import { StatusPill } from "../ui/StatusPill";
import { CoRunDialog, type CoRunTarget } from "./CoRunDialog";
import { MaterialGroups } from "./MaterialGroups";
import { MoveOperationDialog, type MoveTarget } from "./MoveOperationDialog";
import { RunPlanMaterials } from "./RunPlanMaterials";
import { moveOperationTo, saveDayOrder, unlockOperation } from "./dayPlanWrites";
import styles from "./DayPlanPageClient.module.css";

// Dagplan: every resource's work ONE day, in körordning — the list a morning
// meeting walks through. The API owns the selection, the order, the load and
// the material status (GET /planning/day-plan); this page presents, and for
// users with Tillverkning orders the day and moves operations with the
// existing planning routes. Visa: Material (?visa=material) groups each
// resource's rows by ingoing material, with Samkör valda… for the chosen
// ones. `meeting` is Mötesläget: bigger, read-only, reloaded every minute —
// and always in körordning.

const PAGE = "/tillverkning/dagplan";
const MEETING_PAGE = "/tillverkning/dagplan/mote";
const RELOAD_MS = 60_000;

const formatHours = (hours: number): string =>
  hours.toLocaleString("sv-SE", { minimumFractionDigits: 2, maximumFractionDigits: 2 });

interface DragState {
  workCenterId: string;
  moOperationId: string;
}
interface DropState {
  moOperationId: string;
  after: boolean;
}

export function DayPlanPageClient({ meeting = false }: { meeting?: boolean }) {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const dag = searchParams.get("dag") ?? "";
  const grupp = searchParams.get("grupp") ?? "";
  // Mötesläget is the run order on the wall: no Material view there.
  const view: RunPlanView = meeting ? "order" : runPlanView(searchParams.get("visa"));

  // Mötesläget never writes: no ordering, no drag, no row menu, no dialog.
  const can = useCan();
  const canWrite = !meeting && can(["tillverkning"]);

  const [data, setData] = useState<DayPlanResult | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  // Mötesläget: the last background reload failed — the picture is kept.
  const [reloadFailed, setReloadFailed] = useState(false);
  const [reloadTick, setReloadTick] = useState(0);
  const [busy, setBusy] = useState(false);
  // Warnings from a move (I morgon, Lägg på i dag), shown above the list.
  const [notice, setNotice] = useState<{ title: string; warnings: string[] } | null>(null);
  const [moveTarget, setMoveTarget] = useState<MoveTarget | null>(null);
  const [coRunTarget, setCoRunTarget] = useState<CoRunTarget | null>(null);
  const [finePointer, setFinePointer] = useState(false);
  const [drag, setDrag] = useState<DragState | null>(null);
  const [drop, setDrop] = useState<DropState | null>(null);
  const [canFullscreen, setCanFullscreen] = useState(false);
  const [fullscreen, setFullscreen] = useState(false);

  // A background reload keeps the shown picture on failure; a reload the
  // user caused shows the error.
  const silent = useRef(false);
  const hasData = useRef(false);
  hasData.current = data !== null;

  const reload = useCallback(() => setReloadTick((n) => n + 1), []);

  // The shown day has passed (the page stood open over midnight with ?dag=):
  // the next reload answers 400 day-plan-date-out-of-range. Move on to today
  // instead of freezing on yesterday — Mötesläget would otherwise show
  // "Kunde inte läsa om" for ever. Only for a day that WAS shown: a typed
  // address outside the window still gets its error.
  const shownDate = useRef<string | null>(null);
  shownDate.current = data?.date ?? null;
  const showToday = useRef(() => {});
  showToday.current = () =>
    router.replace(dayPlanHref(pathname, { dag: null, grupp, visa: view === "material" ? "material" : null }), { scroll: false });

  useEffect(() => {
    let cancelled = false;
    const background = silent.current && hasData.current;
    silent.current = false;
    if (!background) {
      setLoading(true);
      setError(null);
    }
    const qs = new URLSearchParams();
    if (dag) qs.set("date", dag);
    if (grupp) qs.set("productionGroupId", grupp);
    const query = qs.toString();
    apiFetch<DayPlanResult>(`/api/v1/planning/day-plan${query ? `?${query}` : ""}`)
      .then((res) => {
        if (cancelled) return;
        setData(res);
        setReloadFailed(false);
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        if (dag && shownDate.current === dag && err instanceof ApiError && err.code === "day-plan-date-out-of-range") {
          showToday.current();
          return;
        }
        if (background) setReloadFailed(true);
        else {
          setData(null);
          setError(apiErrorMessage(err, "Kunde inte hämta dagplanen"));
        }
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [dag, grupp, reloadTick]);

  // Mötesläget reads again every minute, only while the tab is visible, and
  // when it becomes visible again.
  useEffect(() => {
    if (!meeting) return;
    const tick = () => {
      if (document.visibilityState !== "visible") return;
      silent.current = true;
      reload();
    };
    const timer = window.setInterval(tick, RELOAD_MS);
    document.addEventListener("visibilitychange", tick);
    return () => {
      window.clearInterval(timer);
      document.removeEventListener("visibilitychange", tick);
    };
  }, [meeting, reload]);

  // Dragging is for a mouse; a touch screen has Upp/Ned.
  useEffect(() => {
    const query = window.matchMedia("(pointer: fine)");
    const update = () => setFinePointer(query.matches);
    update();
    query.addEventListener("change", update);
    return () => query.removeEventListener("change", update);
  }, []);

  // No drag survives a write or a reload: the handle is gone meanwhile, so
  // its dragend would never clear the marks.
  useEffect(() => {
    if (busy || loading) {
      setDrag(null);
      setDrop(null);
    }
  }, [busy, loading]);

  // Helskärm only where the browser has it (not Safari on iPhone).
  useEffect(() => {
    if (!meeting) return;
    setCanFullscreen(document.fullscreenEnabled === true && typeof document.documentElement.requestFullscreen === "function");
    const update = () => setFullscreen(document.fullscreenElement !== null);
    update();
    document.addEventListener("fullscreenchange", update);
    return () => document.removeEventListener("fullscreenchange", update);
  }, [meeting]);

  function toggleFullscreen() {
    if (document.fullscreenElement) void document.exitFullscreen().catch(() => undefined);
    else void document.documentElement.requestFullscreen().catch(() => undefined);
  }

  // URL-driven: ?dag=&grupp=&visa=. No dag = the server's today.
  function show(next: { dag?: string | null; grupp?: string | null; visa?: RunPlanView }) {
    setNotice(null);
    const href = dayPlanHref(pathname, {
      dag: next.dag === undefined ? dag : next.dag,
      grupp: next.grupp === undefined ? grupp : next.grupp,
      visa: (next.visa ?? view) === "material" ? "material" : null,
    });
    router.replace(href, { scroll: false });
  }

  // Ordningen inom dagen: the day's full list of reorderable ids, as Körplan.
  async function reorder(resource: DayPlanResource, ids: string[], from: number, to: number) {
    if (!canWrite) return;
    // A write or a reload is on its way: the list shown may be the old one
    // (the same guard that disables Upp/Ned — also for a drop that began
    // before it).
    if (busy || loading) return;
    if (!data || from === to || from < 0 || to < 0 || from >= ids.length || to >= ids.length) return;
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      await saveDayOrder(resource.workCenter.id, data.date, reorderIds(ids, from, to));
    } catch (err) {
      // The notice, not the error: the reload below clears the error, so
      // a 409 run-plan-order-changed was never seen.
      setNotice({ title: apiErrorMessage(err, "Kunde inte ändra ordningen"), warnings: [] });
    } finally {
      setBusy(false);
      // Also after a 409: the plan changed meanwhile, show it as it is.
      reload();
    }
  }

  // I morgon / Lägg på i dag: Flytta with the following operations, after a
  // confirmation that names the day.
  async function moveTo(row: RunPlanRow, date: string) {
    if (!canWrite) return;
    if (!row.moOperationId) return;
    const ok = await confirmDialog(
      `Flytta op ${row.sequenceNo} på ${row.orderNumber} till ${weekdayShortDate(date)}? Efterföljande operationer följer med och operationen låses.`,
      { confirmLabel: "Flytta" }
    );
    if (!ok) return;
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const res = await moveOperationTo(row.moOperationId, date);
      if (res.warnings.length > 0) {
        setNotice({
          title: `Op ${row.sequenceNo} på ${row.orderNumber} är flyttad till ${weekdayShortDate(date)}. Observera:`,
          warnings: res.warnings.map((w) => w.message),
        });
      }
    } catch (err) {
      setNotice({ title: apiErrorMessage(err, "Kunde inte flytta operationen"), warnings: [] });
    } finally {
      setBusy(false);
      reload();
    }
  }

  async function unlock(row: RunPlanRow) {
    if (!canWrite) return;
    if (!row.moOperationId) return;
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      await unlockOperation(row.moOperationId);
    } catch (err) {
      setNotice({ title: apiErrorMessage(err, "Kunde inte låsa upp operationen"), warnings: [] });
    } finally {
      setBusy(false);
      reload();
    }
  }

  const today = data?.today ?? null;
  const isToday = data !== null && data.date === data.today;
  const { busy: sections, idle } = splitResources(data?.resources ?? []);
  const pdfHref = data
    ? `/api/v1/planning/day-plan/pdf?${new URLSearchParams({ date: data.date, ...(grupp ? { productionGroupId: grupp } : {}) }).toString()}`
    : null;

  const dayTitle = data ? `${weekdayShortDate(data.date)} · v.${data.isoWeek}` : dag ? weekdayShortDate(dag) : "";

  const dayNav = (
    <div className={styles.dayNav}>
      <button
        type="button"
        className={styles.dayButton}
        aria-label="Föregående arbetsdag"
        title="Föregående arbetsdag"
        disabled={!data?.previousDate}
        onClick={() => show({ dag: data?.previousDate ?? null })}
      >
        <ChevronLeft size={meeting ? 26 : 18} aria-hidden="true" />
      </button>
      <h2 className={styles.dayTitle} aria-live="polite">
        {dayTitle}
        {isToday && <span className={styles.todayBadge}>i dag</span>}
      </h2>
      <button
        type="button"
        className={styles.dayButton}
        aria-label="Nästa arbetsdag"
        title="Nästa arbetsdag"
        disabled={!data?.nextDate}
        onClick={() => show({ dag: data?.nextDate ?? null })}
      >
        <ChevronRight size={meeting ? 26 : 18} aria-hidden="true" />
      </button>
      <Button type="button" variant="secondary" size={meeting ? "default" : "small"} disabled={isToday && !error} onClick={() => show({ dag: null })}>
        I dag
      </Button>
    </div>
  );

  const summary = data && (
    <p className={styles.summary}>
      <span>
        <strong className="num">{data.totals.rows}</strong> {data.totals.rows === 1 ? "operation" : "operationer"} ·{" "}
        <strong className="num">{formatHours(data.totals.hours)}</strong> h
      </span>
      {data.totals.shortMaterials > 0 && (
        <span className={styles.summaryWarn}>
          <span className="num">{data.totals.shortMaterials}</span> material saknas
        </span>
      )}
      {data.totals.unlinkedOperations > 0 && (
        <span className={styles.summaryMuted}>
          <span className="num">{data.totals.unlinkedOperations}</span>{" "}
          {data.totals.unlinkedOperations === 1 ? "operation saknar" : "operationer saknar"} kopplat material
        </span>
      )}
    </p>
  );

  return (
    <div className={styles.page} data-meeting={meeting ? "true" : undefined} data-loading={loading && data ? "true" : undefined}>
      {meeting ? (
        <header className={styles.meetingBar}>
          <div className={styles.meetingTitle}>Dagplan</div>
          {dayNav}
          <div className={styles.meetingActions}>
            {reloadFailed && (
              <span className={styles.reloadFailed} role="status">
                Kunde inte läsa om
              </span>
            )}
            {canFullscreen && (
              <Button
                type="button"
                variant="secondary"
                onClick={toggleFullscreen}
                icon={fullscreen ? <Minimize size={18} aria-hidden="true" /> : <Maximize size={18} aria-hidden="true" />}
              >
                {fullscreen ? "Lämna helskärm" : "Helskärm"}
              </Button>
            )}
            <Link href={dayPlanHref(PAGE, { dag, grupp })} className={`${buttonStyles.button} ${buttonStyles.secondary}`}>
              <X size={18} aria-hidden="true" />
              Stäng
            </Link>
          </div>
        </header>
      ) : (
        <div className={styles.toolbar}>
          {dayNav}
          <label className={styles.field}>
            <span className={styles.label}>Grupp</span>
            <Select size="sm" value={grupp} onChange={(e) => show({ grupp: e.target.value || null })} aria-label="Grupp">
              <option value="">Alla resurser</option>
              {(data?.productionGroups ?? []).map((g) => (
                <option key={g.id} value={g.id}>
                  {g.code} · {g.name}
                </option>
              ))}
            </Select>
          </label>
          <div className={styles.field}>
            <span className={styles.label}>Visa</span>
            <SegmentedToggle
              ariaLabel="Visa"
              value={view}
              options={[
                { value: "order", label: "Körordning" },
                { value: "material", label: "Material" },
              ]}
              onChange={(next) => show({ visa: next })}
            />
          </div>
          <div className={styles.toolbarActions}>
            <Link href={dayPlanHref(MEETING_PAGE, { dag, grupp })} className={`${buttonStyles.button} ${buttonStyles.secondary} ${buttonStyles.small}`}>
              <Presentation size={16} aria-hidden="true" />
              Mötesläge
            </Link>
            {pdfHref && <PrintButton href={pdfHref} variant="secondary" />}
          </div>
        </div>
      )}

      <FormError margin="below">{error}</FormError>
      {notice && (
        <FormNotice className={styles.notice}>
          <div className={styles.noticeHead}>
            <span>{notice.title}</span>
            <button type="button" className={styles.noticeClose} aria-label="Stäng meddelandet" onClick={() => setNotice(null)}>
              <X size={16} aria-hidden="true" />
            </button>
          </div>
          <ul className={styles.noticeList}>
            {notice.warnings.map((w, i) => (
              <li key={i}>{w}</li>
            ))}
          </ul>
        </FormNotice>
      )}

      {!data && loading && <FormHint>Hämtar dagplanen…</FormHint>}

      {data && (
        <>
          {summary}

          {sections.length === 0 && <FormHint>Inga planerade operationer den dagen.</FormHint>}

          <div className={styles.resources}>
            {sections.map((resource) => (
              <ResourceSection
                key={resource.workCenter.id}
                resource={resource}
                data={data}
                meeting={meeting}
                view={view}
                canWrite={canWrite}
                canDrag={canWrite && finePointer && !busy && !loading}
                busy={busy || loading}
                drag={drag}
                drop={drop}
                setDrag={setDrag}
                setDrop={setDrop}
                onReorder={(ids, from, to) => void reorder(resource, ids, from, to)}
                onMove={(row) => setMoveTarget(moveTargetOf(row, resource))}
                onMoveTo={(row, date) => void moveTo(row, date)}
                onUnlock={(row) => void unlock(row)}
                onCoRun={(rows) => setCoRunTarget({ workCenter: resource.workCenter, rows, date: data.date })}
              />
            ))}
          </div>

          {idle.length > 0 && sections.length > 0 && (
            <p className={styles.idle}>
              Utan arbete den dagen: <span className="num">{idle.map((r) => r.workCenter.code).join(", ")}</span>
            </p>
          )}
        </>
      )}

      {canWrite && (
        <MoveOperationDialog target={moveTarget} today={today} onClose={() => setMoveTarget(null)} onChanged={reload} />
      )}
      {canWrite && data && (
        <CoRunDialog
          target={coRunTarget}
          today={data.today}
          onClose={() => setCoRunTarget(null)}
          onChanged={reload}
          onConflict={(message) => {
            // The plan changed since the list was read: close, say so and
            // read again (which clears the selection).
            setCoRunTarget(null);
            setNotice({ title: message, warnings: [] });
            reload();
          }}
        />
      )}
    </div>
  );
}

function ResourceSection({
  resource,
  data,
  meeting,
  view,
  canWrite,
  canDrag,
  busy,
  drag,
  drop,
  setDrag,
  setDrop,
  onReorder,
  onMove,
  onMoveTo,
  onUnlock,
  onCoRun,
}: {
  resource: DayPlanResource;
  data: DayPlanResult;
  meeting: boolean;
  view: RunPlanView;
  canWrite: boolean;
  canDrag: boolean;
  busy: boolean;
  drag: DragState | null;
  drop: DropState | null;
  setDrag: (drag: DragState | null) => void;
  setDrop: (drop: DropState | null) => void;
  onReorder: (ids: string[], from: number, to: number) => void;
  onMove: (row: RunPlanRow) => void;
  onMoveTo: (row: RunPlanRow, date: string) => void;
  onUnlock: (row: RunPlanRow) => void;
  onCoRun: (rows: RunPlanRow[]) => void;
}) {
  const { workCenter, load } = resource;
  // Material-läget groups everything the section lists: Kvar från tidigare
  // first, then the day's operations — the order a co-run is sent in.
  const listed = useMemo(() => [...resource.carried, ...resource.rows], [resource]);
  const isToday = data.date === data.today;
  const ids = reorderableIds(resource.rows);
  const percent = loadPercent(load);
  // A warning tone for an overloaded day, and for load on a day without capacity.
  const loadTone = load.overloaded ? "alert" : undefined;
  const dragging = drag?.workCenterId === workCenter.id ? drag : null;

  const columns = canWrite ? "write" : "read";

  function rowProps(row: RunPlanRow) {
    const id = row.moOperationId;
    const index = row.reorderable && id ? ids.indexOf(id) : -1;
    if (!canDrag || index < 0 || !id) return { index, drag: null };
    return {
      index,
      drag: {
        onDragOver: (e: DragEvent<HTMLLIElement>) => {
          // Only within the same resource, among the reorderable rows.
          if (!dragging || dragging.moOperationId === id) return;
          e.preventDefault();
          e.dataTransfer.dropEffect = "move";
          const rect = e.currentTarget.getBoundingClientRect();
          const after = e.clientY > rect.top + rect.height / 2;
          if (drop?.moOperationId !== id || drop.after !== after) setDrop({ moOperationId: id, after });
        },
        onDrop: (e: DragEvent<HTMLLIElement>) => {
          if (!dragging) return;
          e.preventDefault();
          const from = ids.indexOf(dragging.moOperationId);
          const rect = e.currentTarget.getBoundingClientRect();
          const to = dropIndex(from, index, e.clientY > rect.top + rect.height / 2);
          setDrag(null);
          setDrop(null);
          onReorder(ids, from, to);
        },
      },
    };
  }

  function renderRow(row: RunPlanRow, nr: number | null) {
    const { index, drag: dragHandlers } = rowProps(row);
    const id = row.moOperationId;
    const carried = nr === null;
    const planned = plannedDateLabel(row.plannedStartDate, row.plannedEndDate);
    const dropMark = dragging && drop && id && drop.moOperationId === id ? (drop.after ? "after" : "before") : undefined;
    return (
      <li
        key={row.key}
        className={styles.row}
        data-carried={carried ? "true" : undefined}
        data-dragging={dragging && id && dragging.moOperationId === id ? "true" : undefined}
        data-drop={dropMark}
        {...(dragHandlers ?? {})}
      >
        <span className={`${styles.nr} num`}>{nr ?? "–"}</span>
        <span className={styles.order}>
          {meeting ? (
            <span className={styles.orderLink}>{row.orderNumber}</span>
          ) : (
            <GatedLink href={`/tillverkning/ordrar/${row.manufacturingOrderId}`} className={styles.orderLink}>
              {row.orderNumber}
            </GatedLink>
          )}
        </span>
        <span className={styles.article} title={`${row.articleNumber} ${row.articleName}`}>
          <span className="num">{row.articleNumber}</span> <span className={styles.articleName}>{row.articleName}</span>
        </span>
        <span className={styles.operation}>
          <span className={styles.operationText} title={row.description ?? undefined}>
            Op {row.sequenceNo}
            {row.description ? ` ${row.description}` : ""}
          </span>
          {carried && <span className={styles.plannedNote}>{planned ? `Planerad ${planned}` : "Ej planerad"}</span>}
        </span>
        <span className={styles.facts}>
          <span className={`${styles.quantity} num`} data-label="Antal kvar">
            {formatQuantity(row.remainingQuantity)}
          </span>
          <span className={`${styles.hours} num`} data-label="Tid kvar">
            {formatHours(row.remainingHours)}
            <span className={styles.unit}> h</span>
          </span>
          <span className={`${styles.due} num`} data-label="Färdigdatum">
            {formatStockholmDate(row.dueDate)}
          </span>
        </span>
        <span className={styles.status}>
          <StatusPill status={RUN_PLAN_STATUS_PILL[row.status]} label={runPlanStatusText(row)} compact={!meeting} />
          {row.planLocked && <span className={styles.lockBadge}>Låst</span>}
        </span>
        <span className={styles.material} data-label="Material">
          <RunPlanMaterials row={row} links={!meeting} />
        </span>
        <span className={styles.stamps} data-label="Pågår" data-empty={row.activeStamps.length === 0 ? "true" : undefined}>
          {row.activeStamps.map((s) => (
            <span key={s.employeeId} className={styles.stamp} data-paused={s.paused ? "true" : undefined}>
              {stampText(s)}
            </span>
          ))}
        </span>
        {canWrite && (
          <span className={styles.orderCell}>
            {index >= 0 && (
              <>
                {canDrag && id && (
                  <span
                    className={styles.grip}
                    draggable
                    title="Dra för att ändra ordningen"
                    aria-hidden="true"
                    onDragStart={(e) => {
                      e.dataTransfer.effectAllowed = "move";
                      e.dataTransfer.setData("text/plain", id);
                      const li = e.currentTarget.closest("li");
                      if (li) e.dataTransfer.setDragImage(li, 16, 16);
                      setDrag({ workCenterId: workCenter.id, moOperationId: id });
                    }}
                    onDragEnd={() => {
                      setDrag(null);
                      setDrop(null);
                    }}
                  >
                    <GripVertical size={16} />
                  </span>
                )}
                <button
                  type="button"
                  className={styles.moveButton}
                  aria-label="Flytta upp"
                  title="Flytta upp"
                  disabled={busy || index === 0}
                  onClick={() => onReorder(ids, index, index - 1)}
                >
                  <ArrowUp size={16} aria-hidden="true" />
                </button>
                <button
                  type="button"
                  className={styles.moveButton}
                  aria-label="Flytta ned"
                  title="Flytta ned"
                  disabled={busy || index === ids.length - 1}
                  onClick={() => onReorder(ids, index, index + 1)}
                >
                  <ArrowDown size={16} aria-hidden="true" />
                </button>
              </>
            )}
          </span>
        )}
        {canWrite && (
          <span className={styles.menu}>
            <RowMenu
              label={`Åtgärder för op ${row.sequenceNo} på ${row.orderNumber}`}
              items={[
                id ? { label: "Flytta…", onSelect: () => onMove(row), disabled: busy } : null,
                !carried && id && data.nextDate
                  ? { label: isToday ? "I morgon" : "Nästa arbetsdag", onSelect: () => onMoveTo(row, data.nextDate!), disabled: busy }
                  : null,
                carried && isToday && id ? { label: "Lägg på i dag", onSelect: () => onMoveTo(row, data.today), disabled: busy } : null,
                row.planLocked && id ? { label: "Lås upp", onSelect: () => onUnlock(row), disabled: busy } : null,
              ]}
            />
          </span>
        )}
      </li>
    );
  }

  return (
    <section className={styles.resource} aria-label={`${workCenter.code} ${workCenter.name}`}>
      <header className={styles.resourceHeader}>
        <h3 className={styles.resourceTitle}>
          <span className={`${styles.resourceCode} num`}>{workCenter.code}</span>
          <span className={styles.resourceName}>{workCenter.name}</span>
        </h3>
        <div className={styles.load} data-tone={loadTone}>
          <span className={styles.loadText}>{loadText(load)}</span>
          {percent !== null && (
            <span className={styles.loadTrack} aria-hidden="true">
              <span className={styles.loadBar} style={{ width: `${percent}%` }} />
            </span>
          )}
        </div>
        {resource.present.length > 0 && (
          <div className={styles.present}>
            <span className={styles.presentLabel}>På plats:</span> {resource.present.map((p) => p.name).join(", ")}
          </div>
        )}
        {resource.unplannedRows > 0 &&
          (meeting ? (
            <span className={styles.unplanned}>{resource.unplannedRows} ej planerade</span>
          ) : (
            <GatedLink href={`/tillverkning/korplan?resurs=${workCenter.id}`} className={styles.unplanned}>
              {resource.unplannedRows} ej planerade
            </GatedLink>
          ))}
      </header>

      {resource.carried.length + resource.rows.length > 0 && view === "material" ? (
        <MaterialGroups
          rows={listed}
          groups={resource.materialGroups}
          unlinkedRowKeys={resource.unlinkedRowKeys}
          version={data}
          canSelect={canWrite}
          busy={busy}
          onCoRun={onCoRun}
        />
      ) : resource.carried.length + resource.rows.length > 0 ? (
        <div className={styles.list} data-columns={columns}>
          <div className={styles.headRow} aria-hidden="true">
            <span>Nr</span>
            <span>TO</span>
            <span>Operation · Artikel</span>
            <span className={styles.right}>Antal kvar</span>
            <span className={styles.right}>Tid kvar (h)</span>
            <span>Färdigdatum</span>
            <span>Status</span>
            {canWrite && <span>Ordning</span>}
            {canWrite && <span />}
          </div>
          {resource.carried.length > 0 && (
            <>
              <div className={styles.band}>Kvar från tidigare ({resource.carried.length})</div>
              <ul className={styles.rows}>{resource.carried.map((row) => renderRow(row, null))}</ul>
              {resource.rows.length > 0 && <div className={styles.band}>{isToday ? "I dag" : "Dagens operationer"} ({resource.rows.length})</div>}
            </>
          )}
          {resource.rows.length > 0 && <ol className={styles.rows}>{resource.rows.map((row, i) => renderRow(row, i + 1))}</ol>}
        </div>
      ) : (
        <p className={styles.noRows}>Inga planerade operationer den dagen.</p>
      )}
    </section>
  );
}

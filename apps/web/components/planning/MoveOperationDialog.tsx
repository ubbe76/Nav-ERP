"use client";

import { useEffect, useRef, useState, type FormEvent } from "react";
import { Button } from "../ui/Button";
import { Checkbox, Field, Input } from "../ui/Field";
import { FormActions, FormError, FormHint, FormNotice } from "../ui/Form";
import { Modal } from "../ui/Modal";
import { ApiError, apiFetch } from "../../lib/api";
import { dayLoadLine, followingLine, newDaysLine } from "../../lib/capacityDrag";
import { apiErrorMessage } from "../../lib/errorMessages";
import { stockholmToday } from "../../lib/date";
import { plannedDateLabel } from "../../lib/planning";
import type {
  CapacityCellOrder,
  CapacityDayLoad,
  MoveOperationPreview,
  MoveOperationResult,
  PlanWarning,
  UnlockOperationResult,
} from "../../lib/types";
import { previewMove } from "./dayPlanWrites";
import styles from "./MoveOperationDialog.module.css";

const PREVIEW_DELAY_MS = 300;

// What the dialog reads — Beläggning hands in its whole cell order and
// resource row, Dagplan a körplan row and the day's load (lib/dayPlan.ts).
export interface MoveTarget {
  order: Pick<
    CapacityCellOrder,
    | "moOperationId"
    | "orderNumber"
    | "articleNumber"
    | "articleName"
    | "sequenceNo"
    | "remainingHours"
    | "plannedStartDate"
    | "plannedEndDate"
    | "planLocked"
  >;
  resource: { code: string; name: string; dayLoads?: CapacityDayLoad[] };
}

function formatHours(hours: number): string {
  return hours.toLocaleString("sv-SE", { maximumFractionDigits: 1 });
}

// Flytta…: pick the day an operation should start on (not before today, a
// Stockholm day). Moving locks the operation; Lås upp hands it back to Planera.
// The dialog shows the API's preview for the chosen day — the new days, the
// day's load before → after and the warnings — BEFORE Flytta (S33), and sends
// the start day its opener showed as the move's precondition.
export function MoveOperationDialog({
  target,
  today,
  onClose,
  onChanged,
}: {
  target: MoveTarget | null;
  // The Stockholm day from the capacity response (never the browser's date);
  // null where no capacity data was loaded (the order card).
  today?: string | null;
  onClose: () => void;
  // The plan changed — the matrix reloads.
  onChanged: () => void;
}) {
  return (
    <Modal open={target !== null} onClose={onClose} title="Flytta operation">
      {target && <MoveForm target={target} today={today ?? stockholmToday()} onClose={onClose} onChanged={onChanged} />}
    </Modal>
  );
}

function MoveForm({
  target,
  today,
  onClose,
  onChanged,
}: {
  target: MoveTarget;
  today: string;
  onClose: () => void;
  onChanged: () => void;
}) {
  const { order, resource } = target;
  const planStart = order.plannedStartDate;
  const [date, setDate] = useState(planStart && planStart >= today ? planStart : today);
  const [moveFollowing, setMoveFollowing] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Set once a move went through with warnings: the dialog stays to show them.
  const [warnings, setWarnings] = useState<PlanWarning[] | null>(null);
  // The operation's new planned dates, from the move response.
  const [movedDates, setMovedDates] = useState<{ start: string | null; end: string | null; locked: boolean } | null>(null);
  // The preview of the shown choice (day + efterföljande); a late answer
  // never replaces a newer one (request sequence).
  const [preview, setPreview] = useState<{ date: string; moveFollowing: boolean; result: MoveOperationPreview } | null>(null);
  const [previewError, setPreviewError] = useState<string | null>(null);
  const [previewing, setPreviewing] = useState(false);
  const sequence = useRef(0);
  const first = useRef(true);
  const onChangedNow = useRef(onChanged);
  onChangedNow.current = onChanged;
  // The start day the opener showed (null = unplanned): moved since ⇒ 409
  // operation-plan-changed, in the preview and in the move.
  const expectedStartDate = order.plannedStartDate;
  const moOperationId = order.moOperationId;
  const validDate = date !== "" && date >= today;
  const moved = warnings !== null;

  useEffect(() => {
    if (moved) return;
    const seq = ++sequence.current;
    setPreview(null);
    setPreviewError(null);
    if (!validDate) {
      setPreviewing(false);
      return;
    }
    setPreviewing(true);
    const delay = first.current ? 0 : PREVIEW_DELAY_MS;
    first.current = false;
    const timer = window.setTimeout(() => {
      previewMove(moOperationId, { date, moveFollowing, expectedStartDate })
        .then((result) => {
          if (seq !== sequence.current) return;
          setPreview({ date, moveFollowing, result });
        })
        .catch((err: unknown) => {
          if (seq !== sequence.current) return;
          setPreviewError(apiErrorMessage(err, "Kunde inte förhandsvisa flytten"));
          // Moved since the view was read: the view reads again.
          if (err instanceof ApiError && err.code === "operation-plan-changed") onChangedNow.current();
        })
        .finally(() => {
          if (seq === sequence.current) setPreviewing(false);
        });
    }, delay);
    return () => window.clearTimeout(timer);
  }, [date, validDate, moveFollowing, moOperationId, expectedStartDate, moved]);

  // Flytta needs a preview of exactly what is shown, without an error.
  const shown = preview && preview.date === date && preview.moveFollowing === moveFollowing ? preview.result : null;

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (!validDate || !shown || previewError || busy) return;
    setError(null);
    setBusy(true);
    try {
      const res = await apiFetch<MoveOperationResult>(`/api/v1/planning/operations/${order.moOperationId}/move`, {
        method: "POST",
        body: JSON.stringify({ date, moveFollowing, expectedStartDate }),
      });
      onChanged();
      if (res.warnings.length > 0) {
        setMovedDates({ start: res.operation.plannedStartDate, end: res.operation.plannedEndDate, locked: res.operation.planLocked });
        setWarnings(res.warnings);
      } else onClose();
    } catch (err) {
      setError(apiErrorMessage(err, "Kunde inte flytta operationen"));
      // The operation may have changed meanwhile — show the matrix as it is.
      onChanged();
    } finally {
      setBusy(false);
    }
  }

  async function unlock() {
    setError(null);
    setBusy(true);
    try {
      await apiFetch<UnlockOperationResult>(`/api/v1/planning/operations/${order.moOperationId}/unlock`, {
        method: "POST",
      });
      onChanged();
      onClose();
    } catch (err) {
      setError(apiErrorMessage(err, "Kunde inte låsa upp operationen"));
      onChanged();
    } finally {
      setBusy(false);
    }
  }

  // "ledigt 3 h av 8" from the resource's day loads, when the day is loaded;
  // a day without capacity (weekend, red day) says so — a move there is refused.
  const dayLoad = resource.dayLoads?.find((d) => d.date === date);
  const freeText =
    dayLoad && dayLoad.availableHours !== null
      ? dayLoad.availableHours <= 0
        ? "ingen kapacitet den dagen"
        : `ledigt ${formatHours(Math.max(0, dayLoad.availableHours - dayLoad.loadHours))} h av ${formatHours(dayLoad.availableHours)}`
      : null;

  const planned = movedDates
    ? plannedDateLabel(movedDates.start, movedDates.end)
    : plannedDateLabel(order.plannedStartDate, order.plannedEndDate);

  return (
    <form onSubmit={submit}>
      <dl className={styles.facts}>
        <dt>Tillverkningsorder</dt>
        <dd>{order.orderNumber}</dd>
        <dt>Artikel</dt>
        <dd>
          {order.articleNumber} — {order.articleName}
        </dd>
        <dt>Operation</dt>
        <dd>
          Op {order.sequenceNo} · {resource.code} · {resource.name}
        </dd>
        <dt>Kvar</dt>
        <dd>{formatHours(order.remainingHours)} h</dd>
        <dt>Planerad</dt>
        <dd>
          {planned ?? "Ej planerad"}
          {(movedDates ? movedDates.locked : order.planLocked) ? " · Låst" : ""}
        </dd>
      </dl>

      <Field label="Dag" htmlFor="moveDate">
        <Input id="moveDate" type="date" min={today} value={date} onChange={(e) => setDate(e.target.value)} disabled={busy || warnings !== null} />
        {freeText && <FormHint>{freeText}</FormHint>}
      </Field>

      <label className={styles.check}>
        <Checkbox checked={moveFollowing} disabled={busy || warnings !== null} onChange={(e) => setMoveFollowing(e.target.checked)} />
        <span>Flytta även efterföljande operationer</span>
      </label>

      {!moved && previewing && <FormHint>Räknar…</FormHint>}
      {!moved && <FormError>{previewError}</FormError>}
      {!moved && shown && (
        <div className={styles.preview} aria-live="polite">
          {newDaysLine(shown) && <div>{newDaysLine(shown)}</div>}
          {moveFollowing && followingLine(shown) && <div>{followingLine(shown)}</div>}
          <div data-overloaded={shown.dayLoad.after.overloaded}>{dayLoadLine(shown.dayLoad)}</div>
          {shown.warnings.length > 0 && (
            <>
              <div className={styles.previewHeading}>Observera:</div>
              <ul className={styles.warnings}>
                {shown.warnings.map((w, i) => (
                  <li key={i}>{w.message}</li>
                ))}
              </ul>
            </>
          )}
        </div>
      )}

      <FormError>{error}</FormError>
      {warnings && (
        <>
          <FormNotice>Operationen är flyttad. Observera:</FormNotice>
          <ul className={styles.warnings}>
            {warnings.map((w, i) => (
              <li key={i}>{w.message}</li>
            ))}
          </ul>
        </>
      )}

      <FormActions>
        {warnings === null && (
          <Button type="submit" variant="primary" disabled={busy || !validDate || !shown || previewError !== null}>
            {busy ? "Flyttar…" : "Flytta"}
          </Button>
        )}
        {warnings === null && order.planLocked && (
          <Button type="button" variant="secondary" disabled={busy} onClick={unlock}>
            Lås upp
          </Button>
        )}
        <Button type="button" variant="secondary" onClick={onClose}>
          {warnings === null ? "Avbryt" : "Stäng"}
        </Button>
      </FormActions>
    </form>
  );
}

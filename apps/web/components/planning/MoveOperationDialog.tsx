"use client";

import { useState, type FormEvent } from "react";
import { Button } from "../ui/Button";
import { Checkbox, Field, Input } from "../ui/Field";
import { FormActions, FormError, FormHint, FormNotice } from "../ui/Form";
import { Modal } from "../ui/Modal";
import { apiFetch } from "../../lib/api";
import { apiErrorMessage } from "../../lib/errorMessages";
import { stockholmToday } from "../../lib/date";
import { plannedDateLabel } from "../../lib/planning";
import type {
  CapacityCellOrder,
  CapacityDayLoad,
  MoveOperationResult,
  PlanWarning,
  UnlockOperationResult,
} from "../../lib/types";
import styles from "./MoveOperationDialog.module.css";

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

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (!date || date < today) return;
    setError(null);
    setBusy(true);
    try {
      const res = await apiFetch<MoveOperationResult>(`/api/v1/planning/operations/${order.moOperationId}/move`, {
        method: "POST",
        body: JSON.stringify({ date, moveFollowing }),
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
          <Button type="submit" variant="primary" disabled={busy || !date}>
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

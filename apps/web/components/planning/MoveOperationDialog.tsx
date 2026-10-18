"use client";

import { useState, type FormEvent } from "react";
import { Button } from "../ui/Button";
import { Checkbox, Field, Select } from "../ui/Field";
import { FormActions, FormError, FormHint, FormNotice } from "../ui/Form";
import { Modal } from "../ui/Modal";
import { apiFetch } from "../../lib/api";
import { apiErrorMessage } from "../../lib/errorMessages";
import { plannedWeekLabel, shortDate } from "../../lib/planning";
import type {
  CapacityCellOrder,
  CapacityResourceRow,
  CapacityWeek,
  MoveOperationResult,
  PlanWarning,
  UnlockOperationResult,
} from "../../lib/types";
import styles from "./MoveOperationDialog.module.css";

export interface MoveTarget {
  order: CapacityCellOrder;
  resource: CapacityResourceRow;
}

function formatHours(hours: number): string {
  return hours.toLocaleString("sv-SE", { maximumFractionDigits: 1 });
}

// Flytta…: pick the week an operation should start in. The options are the
// matrix's own week columns (their Mondays come from the API — never derived
// from a browser Date, so the timezone cannot shift a week). Moving locks the
// operation; Lås upp hands it back to Planera.
export function MoveOperationDialog({
  target,
  weeks,
  onClose,
  onChanged,
}: {
  target: MoveTarget | null;
  weeks: CapacityWeek[];
  onClose: () => void;
  // The plan changed — the matrix reloads.
  onChanged: () => void;
}) {
  return (
    <Modal open={target !== null} onClose={onClose} title="Flytta operation">
      {target && <MoveForm target={target} weeks={weeks} onClose={onClose} onChanged={onChanged} />}
    </Modal>
  );
}

function MoveForm({
  target,
  weeks,
  onClose,
  onChanged,
}: {
  target: MoveTarget;
  weeks: CapacityWeek[];
  onClose: () => void;
  onChanged: () => void;
}) {
  const { order, resource } = target;
  const spansMultipleYears = new Set(weeks.map((w) => w.isoYear)).size > 1;
  const current = order.plannedStartWeek && weeks.some((w) => w.monday === order.plannedStartWeek) ? order.plannedStartWeek : null;
  const [weekMonday, setWeekMonday] = useState(current ?? weeks[0]?.monday ?? "");
  const [moveFollowing, setMoveFollowing] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Set once a move went through with warnings: the dialog stays to show them.
  const [warnings, setWarnings] = useState<PlanWarning[] | null>(null);
  // The order's new planned weeks, from the move response.
  const [movedWeeks, setMovedWeeks] = useState<{ start: string | null; end: string | null; locked: boolean } | null>(null);

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (!weekMonday) return;
    setError(null);
    setBusy(true);
    try {
      const res = await apiFetch<MoveOperationResult>(`/api/v1/planning/operations/${order.moOperationId}/move`, {
        method: "POST",
        body: JSON.stringify({ weekMonday, moveFollowing }),
      });
      onChanged();
      if (res.warnings.length > 0) {
        setMovedWeeks({ start: res.operation.plannedStartWeek, end: res.operation.plannedEndWeek, locked: res.operation.planLocked });
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

  const planned = movedWeeks
    ? plannedWeekLabel(movedWeeks.start, movedWeeks.end)
    : plannedWeekLabel(order.plannedStartWeek, order.plannedEndWeek);

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
          {(movedWeeks ? movedWeeks.locked : order.planLocked) ? " · Låst" : ""}
        </dd>
      </dl>

      <Field label="Vecka" htmlFor="moveWeek">
        <Select id="moveWeek" value={weekMonday} onChange={(e) => setWeekMonday(e.target.value)} disabled={busy || warnings !== null}>
          {weeks.map((w, i) => {
            const cell = resource.weeks[i];
            // The current week's matrix figure is the whole week; only the
            // days from today can still be used, so no free-time figure there.
            const free =
              i === 0
                ? " — innevarande vecka"
                : cell && cell.availableHours !== null
                  ? ` — ledigt ${formatHours(Math.max(cell.availableHours - cell.loadHours, 0))} h av ${formatHours(cell.availableHours)}`
                  : "";
            const year = spansMultipleYears ? ` ${w.isoYear}` : "";
            return (
              <option key={w.monday} value={w.monday}>
                {`v.${w.isoWeek}${year} · ${shortDate(w.monday)}${free}`}
              </option>
            );
          })}
        </Select>
      </Field>
      <FormHint attached>Fler veckor nås genom att öka Veckor i beläggningen.</FormHint>

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
          <Button type="submit" variant="primary" disabled={busy || !weekMonday}>
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

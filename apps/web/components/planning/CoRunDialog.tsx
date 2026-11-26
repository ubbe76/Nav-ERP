"use client";

import { useEffect, useMemo, useRef, useState, type FormEvent } from "react";
import { ApiError } from "../../lib/api";
import { coRunFollowingText, coRunLoadText, coRunOperationText, coRunPayload, materialGroupText } from "../../lib/coRun";
import { materialText } from "../../lib/dayPlan";
import { formatStockholmDate } from "../../lib/date";
import { apiErrorMessage } from "../../lib/errorMessages";
import { weekdayShortDate } from "../../lib/planning";
import type { CoRunResult, RunPlanRow, RunPlanStation } from "../../lib/types";
import { Button } from "../ui/Button";
import { Field, Input } from "../ui/Field";
import { FormActions, FormError, FormHint, FormNotice } from "../ui/Form";
import { Modal } from "../ui/Modal";
import { previewCoRun, writeCoRun } from "./dayPlanWrites";
import styles from "./CoRunDialog.module.css";

// Samkör: the chosen operations of ONE resource moved to one day, laid next
// to each other in the run order and locked. The dialog is the confirmation:
// it shows what the API's preview computed for the chosen day (the same
// rules as the write) before anything is written.

const PREVIEW_DELAY_MS = 300;

export interface CoRunTarget {
  workCenter: RunPlanStation;
  // The chosen rows, in the order the list showed them.
  rows: RunPlanRow[];
  // The day the dialog starts on.
  date: string;
}

export function CoRunDialog({
  target,
  today,
  onClose,
  onChanged,
  onConflict,
}: {
  target: CoRunTarget | null;
  // The Stockholm day of the page's response — never the browser's date.
  today: string;
  onClose: () => void;
  // The plan changed (or may have): the page reads again.
  onChanged: () => void;
  // 409 co-run-changed on the write: the dialog closes and the page shows
  // the message, reads again and clears the selection.
  onConflict: (message: string) => void;
}) {
  return (
    <Modal open={target !== null} onClose={onClose} title="Samkör">
      {target && <CoRunForm target={target} today={today} onClose={onClose} onChanged={onChanged} onConflict={onConflict} />}
    </Modal>
  );
}

function CoRunForm({
  target,
  today,
  onClose,
  onChanged,
  onConflict,
}: {
  target: CoRunTarget;
  today: string;
  onClose: () => void;
  onChanged: () => void;
  onConflict: (message: string) => void;
}) {
  const { workCenter, rows } = target;
  const [date, setDate] = useState(target.date);
  const [preview, setPreview] = useState<CoRunResult | null>(null);
  const [previewError, setPreviewError] = useState<string | null>(null);
  const [previewing, setPreviewing] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Set once the co-run is written: the dialog stays to show the outcome.
  const [written, setWritten] = useState<CoRunResult | null>(null);

  // A late answer never overwrites a newer one: only the latest request's
  // answer is shown. The first preview is asked for at once, a changed day
  // after a short pause.
  const sequence = useRef(0);
  const first = useRef(true);
  const validDate = date !== "" && date >= today;

  useEffect(() => {
    if (written) return;
    const seq = ++sequence.current;
    setPreview(null);
    setPreviewError(null);
    setError(null);
    if (!validDate) {
      setPreviewing(false);
      return;
    }
    setPreviewing(true);
    const delay = first.current ? 0 : PREVIEW_DELAY_MS;
    first.current = false;
    const timer = window.setTimeout(() => {
      previewCoRun(coRunPayload(workCenter.id, date, rows))
        .then((res) => {
          if (seq !== sequence.current) return;
          setPreview(res);
        })
        .catch((err: unknown) => {
          if (seq !== sequence.current) return;
          setPreviewError(apiErrorMessage(err, "Kunde inte förhandsvisa samkörningen"));
        })
        .finally(() => {
          if (seq === sequence.current) setPreviewing(false);
        });
    }, delay);
    return () => window.clearTimeout(timer);
  }, [date, validDate, rows, workCenter.id, written]);

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (!preview || preview.date !== date || previewError || busy) return;
    setBusy(true);
    setError(null);
    try {
      const res = await writeCoRun(coRunPayload(workCenter.id, date, rows));
      setWritten(res);
      onChanged();
    } catch (err) {
      const message = apiErrorMessage(err, "Kunde inte samköra operationerna");
      if (err instanceof ApiError && err.code === "co-run-changed") onConflict(message);
      else {
        setError(message);
        // The plan may have changed meanwhile — show the list as it is.
        onChanged();
      }
    } finally {
      setBusy(false);
    }
  }

  const shown = written ?? preview;
  const canSubmit = !busy && !previewing && preview !== null && preview.date === date && previewError === null;

  return (
    <form onSubmit={submit}>
      <p className={styles.resource}>
        <span className="num">{workCenter.code}</span> · {workCenter.name} · <span className="num">{rows.length}</span> operationer
      </p>

      <Field label="Dag" htmlFor="coRunDate">
        <Input
          id="coRunDate"
          type="date"
          min={today}
          value={date}
          required
          disabled={busy || written !== null}
          onChange={(e) => setDate(e.target.value)}
        />
      </Field>

      {written && <FormNotice className={styles.done}>Operationerna är samkörda på {weekdayShortDate(written.date)} och låsta.</FormNotice>}

      {!written && !validDate && <FormHint className={styles.pending}>Välj i dag eller en senare dag.</FormHint>}
      {!written && validDate && previewing && <FormHint className={styles.pending}>Räknar…</FormHint>}
      <FormError margin="above">{previewError}</FormError>

      {shown && <CoRunSummary result={shown} rows={rows} written={written !== null} />}

      {!written && (
        <FormHint className={styles.help}>
          Operationerna låses på dagen — Planera flyttar dem inte förrän någon väljer Lås upp. Ställtiden räknas per operation även när jobben körs
          ihop.
        </FormHint>
      )}

      <FormError margin="above">{error}</FormError>

      <FormActions>
        {written === null && (
          <Button type="submit" variant="primary" disabled={!canSubmit}>
            {busy ? "Samkör…" : "Samkör"}
          </Button>
        )}
        <Button type="button" variant="secondary" onClick={onClose}>
          {written === null ? "Avbryt" : "Stäng"}
        </Button>
      </FormActions>
    </form>
  );
}

// What the preview computed, or what the write wrote — the same answer.
function CoRunSummary({ result, rows, written }: { result: CoRunResult; rows: RunPlanRow[]; written: boolean }) {
  // The article and the operation text come from the rows the list showed.
  const rowOf = useMemo(() => new Map(rows.map((row) => [row.moOperationId, row])), [rows]);
  // "kommer d": where a chosen row's missing material is expected from.
  const supplyOf = (articleId: string) => {
    for (const row of rows) {
      const material = row.materials.find((m) => m.articleId === articleId && m.status === "short" && m.supply);
      if (material) return materialText(material);
    }
    return null;
  };
  // Blir sena has the late orders; the list keeps the rest.
  const warnings = result.warnings.filter((w) => w.kind !== "late");

  return (
    <div className={styles.summary}>
      <section className={styles.section}>
        <h3 className={styles.heading}>Operationer</h3>
        <ul className={styles.list}>
          {result.operations.map((op) => {
            const row = rowOf.get(op.moOperationId);
            return (
              <li key={op.moOperationId} className={styles.item}>
                <span className={styles.what}>
                  <strong>{op.orderNumber}</strong> · op {op.sequenceNo}
                  {row ? <span className={styles.muted}> · {row.articleNumber} {row.articleName}</span> : null}
                </span>
                <span className={styles.outcome} data-tone={op.outcome === "not_placed" ? "alert" : op.outcome === "already_on_day" ? "muted" : undefined}>
                  {coRunOperationText(op)}
                </span>
              </li>
            );
          })}
        </ul>
      </section>

      <section className={styles.section}>
        <h3 className={styles.heading}>Dagens last</h3>
        <p className={styles.load} data-tone={result.dayLoad.after.overloaded ? "alert" : undefined}>
          {coRunLoadText(result.dayLoad)}
        </p>
      </section>

      {result.following.length > 0 && (
        <section className={styles.section}>
          <h3 className={styles.heading}>Flyttas också</h3>
          <ul className={styles.list}>
            {result.following.map((op) => (
              <li key={op.moOperationId} className={styles.item}>
                <span className={styles.what}>
                  <strong>{op.orderNumber}</strong> · op {op.sequenceNo} · <span className="num">{op.workCenterCode}</span>
                </span>
                <span className={styles.outcome}>{coRunFollowingText(op)}</span>
              </li>
            ))}
          </ul>
        </section>
      )}

      {result.lateOrders.length > 0 && (
        <section className={styles.section} data-tone="alert">
          <h3 className={styles.heading}>Blir sena</h3>
          <ul className={styles.list}>
            {result.lateOrders.map((order) => (
              <li key={order.manufacturingOrderId} className={styles.item}>
                <span className={styles.what}>
                  <strong>{order.orderNumber}</strong>
                </span>
                <span className={styles.outcome} data-tone="alert">
                  {order.plannedFinish ? `klar ${weekdayShortDate(order.plannedFinish)}` : "klar-dag saknas"}
                  {order.dueDate ? ` · färdigdatum ${formatStockholmDate(order.dueDate)}` : ""}
                </span>
              </li>
            ))}
          </ul>
        </section>
      )}

      {warnings.length > 0 && (
        <section className={styles.section}>
          <h3 className={styles.heading}>Observera</h3>
          <ul className={styles.warnings}>
            {warnings.map((w, i) => (
              <li key={i}>
                <strong>{w.orderNumber}:</strong> {w.message}
              </li>
            ))}
          </ul>
        </section>
      )}

      {result.materials.length > 0 && (
        <section className={styles.section}>
          <h3 className={styles.heading}>Material</h3>
          <ul className={styles.list}>
            {result.materials.map((group) => {
              const supply = group.short ? supplyOf(group.articleId) : null;
              return (
                <li key={group.articleId} className={styles.item}>
                  <span className={styles.what}>
                    <strong className="num">{group.articleNumber}</strong> {group.articleName}
                  </span>
                  <span className={styles.outcome} data-tone={group.short ? "alert" : "muted"}>
                    {materialGroupText(group)}
                    {group.short ? " · räcker inte" : ""}
                    {supply ? ` · ${supply.text}${supply.document ? ` · ${supply.document.number}` : ""}` : ""}
                  </span>
                </li>
              );
            })}
          </ul>
        </section>
      )}

      {result.runOrder.length > 0 && (
        <section className={styles.section}>
          <h3 className={styles.heading}>
            Körordning {weekdayShortDate(result.date)}
            {written ? "" : " efter samkörningen"}
          </h3>
          <ol className={styles.runOrder}>
            {result.runOrder.map((op) => (
              <li key={op.moOperationId} data-selected={op.selected ? "true" : undefined}>
                <span>
                  {op.orderNumber} · op {op.sequenceNo}
                </span>
                {op.selected && <span className={styles.selectedTag}>{written ? "samkörd" : "samkörs"}</span>}
              </li>
            ))}
          </ol>
        </section>
      )}
    </div>
  );
}

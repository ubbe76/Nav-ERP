"use client";

import { useEffect, useRef, useState, type CSSProperties, type FormEvent } from "react";
import { ApiError } from "../../lib/api";
import { apiErrorMessage } from "../../lib/errorMessages";
import { shortDate } from "../../lib/planning";
import {
  REPLAN_CHANGED_NOTICE,
  blockedText,
  conflictResult,
  currentDueDate,
  dueDateChangeText,
  floorText,
  includedIds,
  notPlannedText,
  operationText,
  operationsText,
  overloadedDayText,
  plannedChangeText,
  replanPayload,
  replanRequest,
  requestKey,
  sharedText,
  toggleInclude,
  validDueDate,
  writtenText,
  type ReplanForm,
} from "../../lib/replanStructure";
import type { ReplanStructureOrder, ReplanStructureRequest, ReplanStructureResult } from "../../lib/types";
import { Button } from "../ui/Button";
import { Checkbox, Field, Input } from "../ui/Field";
import { FormActions, FormError, FormHint, FormNotice } from "../ui/Form";
import { Modal } from "../ui/Modal";
import { previewReplanStructure, writeReplanStructure } from "./structureWrites";
import styles from "./ReplanStructureDialog.module.css";

// Planera om strukturen: a TO and the chosen halvfabrikat-TOs under it are
// planned again, children before parents, and the days are locked. The dialog
// is the confirmation: it shows what the API's preview computed for exactly
// the shown choice (the same rules as the write) before anything is written.

const PREVIEW_DELAY_MS = 300;
// The indent stops here — a deep tree keeps its text on a phone.
const MAX_INDENT = 4;

export interface ReplanStructureTarget {
  manufacturingOrderId: string;
  orderNumber: string;
}

export function ReplanStructureDialog({
  target,
  onClose,
  onChanged,
}: {
  target: ReplanStructureTarget | null;
  onClose: () => void;
  // The plan changed (or may have): the page reads again.
  onChanged: () => void;
}) {
  return (
    <Modal open={target !== null} onClose={onClose} title="Planera om strukturen">
      {target && <ReplanForm key={target.manufacturingOrderId} target={target} onClose={onClose} onChanged={onChanged} />}
    </Modal>
  );
}

// A preview and the request it answers — the write sends exactly this pair.
interface Shown {
  request: ReplanStructureRequest;
  result: ReplanStructureResult;
}

function ReplanForm({ target, onClose, onChanged }: { target: ReplanStructureTarget; onClose: () => void; onChanged: () => void }) {
  const topId = target.manufacturingOrderId;
  const [form, setForm] = useState<ReplanForm>({ dueDate: "", moveComponentDueDates: true, chosen: null });
  const [shown, setShown] = useState<Shown | null>(null);
  const [previewError, setPreviewError] = useState<string | null>(null);
  const [previewing, setPreviewing] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  // Set once the structure is written: the dialog stays to show the outcome.
  const [written, setWritten] = useState<ReplanStructureResult | null>(null);
  // Asks for the same preview once more (after a refused write).
  const [again, setAgain] = useState(0);

  // A late answer never overwrites a newer one: only the latest request's
  // answer is shown. The first preview is asked for at once, a changed choice
  // after a short pause.
  const sequence = useRef(0);
  const first = useRef(true);
  // The key of the request the shown preview answers — set with it, so the
  // effect knows the preview on screen is already the form's.
  const shownKey = useRef<string | null>(null);
  // Read when an answer lands, not from the effect's closure: "manuellt
  // vinner" — a date the user typed meanwhile is never replaced.
  const formNow = useRef(form);
  formNow.current = form;
  const dueTouched = useRef(false);

  const currentDue = shown ? currentDueDate(shown.result) : null;
  const today = shown?.result.today ?? null;
  const request = replanRequest(form, currentDue);
  const key = requestKey(request);
  const requestNow = useRef(request);
  requestNow.current = request;
  const validDate = validDueDate(form.dueDate, currentDue, today);

  // The answer becomes the shown preview, and the form follows it: the choice
  // is the answer's, and an untouched date field shows the top's own date.
  function adopt(result: ReplanStructureResult) {
    const due = currentDueDate(result);
    const next: ReplanForm = {
      dueDate: dueTouched.current ? formNow.current.dueDate : (due ?? ""),
      moveComponentDueDates: formNow.current.moveComponentDueDates,
      chosen: includedIds(result),
    };
    const answered = replanRequest(next, due);
    shownKey.current = requestKey(answered);
    formNow.current = next;
    setForm(next);
    setShown({ request: answered, result });
  }

  useEffect(() => {
    if (written) return;
    const seq = ++sequence.current;
    // The preview on screen is already the preview of this form.
    if (shownKey.current === key) {
      setPreviewing(false);
      return;
    }
    setPreviewError(null);
    if (!validDate) {
      setPreviewing(false);
      return;
    }
    setPreviewing(true);
    const delay = first.current ? 0 : PREVIEW_DELAY_MS;
    first.current = false;
    const timer = window.setTimeout(() => {
      previewReplanStructure(topId, requestNow.current)
        .then((result) => {
          if (seq !== sequence.current) return;
          adopt(result);
        })
        .catch((err: unknown) => {
          if (seq !== sequence.current) return;
          // A chosen TO may no longer be chosen: the answer carries the
          // preview of the part that may.
          const fresh = err instanceof ApiError && err.code === "replan-structure-changed" ? conflictResult(err.body) : null;
          if (fresh) {
            adopt(fresh);
            setNotice(REPLAN_CHANGED_NOTICE);
          } else setPreviewError(apiErrorMessage(err, "Kunde inte förhandsvisa omplaneringen"));
        })
        .finally(() => {
          if (seq === sequence.current) setPreviewing(false);
        });
    }, delay);
    return () => window.clearTimeout(timer);
    // `adopt` reads refs only; the request is the one of `key`.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, validDate, topId, written, again]);

  // A change by the user: the old messages no longer describe the form.
  function change(patch: Partial<ReplanForm>) {
    setError(null);
    setNotice(null);
    setForm((f) => ({ ...f, ...patch }));
  }

  // Only the preview of exactly the shown form may be written.
  const current = shown !== null && shownKey.current === key && requestKey(shown.request) === key;
  const blocked = shown ? blockedText(shown.result.blocked) : null;
  const canSubmit = !busy && !previewing && current && validDate && previewError === null && blocked === null && written === null;

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (!canSubmit || !shown) return;
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const result = await writeReplanStructure(topId, replanPayload(shown.result, shown.request));
      setWritten(result);
      onChanged();
    } catch (err) {
      const fresh = err instanceof ApiError && err.code === "replan-structure-changed" ? conflictResult(err.body) : null;
      if (fresh) {
        // Nothing was written: the fresh preview is shown, and the user
        // decides again.
        adopt(fresh);
        setNotice(REPLAN_CHANGED_NOTICE);
      } else {
        setError(apiErrorMessage(err, "Kunde inte planera om strukturen"));
        // The plan may have changed meanwhile — ask for the preview again.
        shownKey.current = null;
        setAgain((n) => n + 1);
      }
      onChanged();
    } finally {
      setBusy(false);
    }
  }

  const result = written ?? shown?.result ?? null;
  const top = result?.orders[0] ?? null;
  const locked = busy || written !== null;
  const klarDag = top?.plannedFinish ?? null;
  const chosen = new Set(form.chosen ?? []);

  return (
    <form onSubmit={submit} noValidate>
      <p className={styles.top}>
        <strong>{top?.orderNumber ?? target.orderNumber}</strong>
        {top ? ` · ${top.articleNumber} ${top.articleName}` : ""}
      </p>

      <div className={styles.dueRow}>
        <Field label="Färdigdatum" htmlFor="replanDueDate">
          <Input
            id="replanDueDate"
            type="date"
            min={today ?? undefined}
            value={form.dueDate}
            disabled={locked}
            onChange={(e) => {
              dueTouched.current = true;
              change({ dueDate: e.target.value });
            }}
          />
        </Field>
        {!written && klarDag !== null && form.dueDate !== klarDag && (
          <Button
            type="button"
            variant="secondary"
            disabled={locked}
            title={`Klar-dagen i förhandsvisningen: ${shortDate(klarDag)}`}
            onClick={() => {
              dueTouched.current = true;
              change({ dueDate: klarDag });
            }}
          >
            Sätt till klar-dagen
          </Button>
        )}
      </div>
      {!written && (
        <FormHint className={styles.dueHint}>
          {validDate ? "Tomt fält = färdigdatumet lämnas som det är. Datumet styr inte dagarna — bara Sen." : "Välj i dag eller en senare dag."}
        </FormHint>
      )}

      {result !== null && result.orders.length > 1 && (
        <label className={styles.check}>
          <Checkbox
            checked={form.moveComponentDueDates}
            disabled={locked}
            onChange={(e) => change({ moveComponentDueDates: e.target.checked })}
          />
          <span>Flytta även halvfabrikatens färdigdatum</span>
        </label>
      )}

      {written && <FormNotice className={styles.done}>{writtenText(written)}</FormNotice>}
      {!written && notice && <FormNotice className={styles.done}>{notice}</FormNotice>}
      {!written && validDate && previewing && <FormHint className={styles.pending}>Räknar…</FormHint>}
      <FormError margin="above">{previewError}</FormError>

      {result && (
        <div className={styles.summary} data-stale={written === null && !current ? "true" : undefined}>
          <section className={styles.section}>
            <h3 className={styles.heading}>Tillverkningsordrar</h3>
            <ul className={styles.orders}>
              {result.orders.map((order) => (
                <OrderItem
                  key={order.manufacturingOrderId}
                  order={order}
                  parent={result.orders.find((o) => o.manufacturingOrderId === order.parentOrderId) ?? null}
                  checked={order.level === 0 || (written ? order.included : chosen.has(order.manufacturingOrderId))}
                  disabled={locked}
                  onToggle={() => change({ chosen: toggleInclude(result, form.chosen ?? includedIds(result), order.manufacturingOrderId) })}
                />
              ))}
            </ul>
          </section>

          {result.overloadedDays.length > 0 && (
            <section className={`${styles.section} ${styles.extra}`}>
              <h3 className={styles.heading}>Överbelagda dagar</h3>
              <ul className={styles.list} data-tone="alert">
                {result.overloadedDays.map((day) => (
                  <li key={`${day.workCenterCode}:${day.date}`}>{overloadedDayText(day)}</li>
                ))}
              </ul>
            </section>
          )}

          {(result.warnings.some((w) => w.kind !== "late") || result.notes.length > 0) && (
            <section className={`${styles.section} ${styles.extra}`}>
              <h3 className={styles.heading}>Observera</h3>
              <ul className={styles.list}>
                {/* Sen stands on each TO; the list keeps the rest. */}
                {result.warnings
                  .filter((w) => w.kind !== "late")
                  .map((w, i) => (
                    <li key={`w${i}`}>
                      <strong>{w.orderNumber}:</strong> {w.message}
                    </li>
                  ))}
                {result.notes.map((note, i) => (
                  <li key={`n${i}`}>{note}</li>
                ))}
              </ul>
            </section>
          )}
        </div>
      )}

      {!written && <FormError margin="above">{blocked}</FormError>}

      {!written && (
        <FormHint className={styles.help}>
          Halvfabrikaten planeras först, och varje order får börja den dag dess material är klart. Operationerna låses på sina dagar — Planera
          flyttar dem inte förrän någon väljer Lås upp hela ordern. Resursen byts aldrig.
        </FormHint>
      )}

      <FormError margin="above">{error}</FormError>

      <FormActions>
        {written === null && (
          <Button type="submit" variant="primary" disabled={!canSubmit}>
            {busy ? "Planerar om…" : "Planera om"}
          </Button>
        )}
        <Button type="button" variant="secondary" onClick={onClose}>
          {written === null ? "Avbryt" : "Stäng"}
        </Button>
      </FormActions>
    </form>
  );
}

// One TO of the tree: the box (the top's is fixed), and what the preview
// says about it.
function OrderItem({
  order,
  parent,
  checked,
  disabled,
  onToggle,
}: {
  order: ReplanStructureOrder;
  parent: ReplanStructureOrder | null;
  checked: boolean;
  disabled: boolean;
  onToggle: () => void;
}) {
  const isTop = order.level === 0;
  const boxId = `replan-${order.manufacturingOrderId}`;
  const floor = order.included ? floorText(order.floor) : null;
  const shared = sharedText(order);
  // A halvfabrikat under a TO that is not chosen cannot be chosen.
  const underUnchosen = !isTop && !order.selectable && parent !== null && !parent.included;
  return (
    <li className={styles.order} style={{ "--level": Math.min(order.level, MAX_INDENT) } as CSSProperties}>
      <span className={styles.orderBox}>
        <Checkbox
          id={boxId}
          checked={checked}
          disabled={disabled || isTop || !order.selectable}
          title={isTop ? "Ordern planeras alltid om" : underUnchosen ? `Välj ${parent.orderNumber} först` : undefined}
          onChange={onToggle}
        />
      </span>
      <div className={styles.orderBody}>
        <label htmlFor={boxId} className={styles.orderTitle} data-fixed={isTop || !order.selectable ? "true" : undefined}>
          <span>
            <strong>{order.orderNumber}</strong>
            <span className={styles.muted}>
              {" "}
              · {order.articleNumber} {order.articleName}
            </span>
          </span>
          {order.lateAfter && <span className={styles.late}>Sen</span>}
        </label>
        <div className={styles.lines}>
          {!order.included && <span className={styles.muted}>{underUnchosen ? `${notPlannedText(order)} (välj ${parent.orderNumber} först)` : notPlannedText(order)}</span>}
          {order.included && shared && <span className={styles.muted}>{shared}</span>}
          <span>
            Planerad: {plannedChangeText(order.planned)}
            {order.plannedFinish ? ` · klar ${shortDate(order.plannedFinish)}` : ""}
          </span>
          <span>Färdigdatum: {dueDateChangeText(order.dueDate)}</span>
          {floor && <span className={styles.muted}>{floor}</span>}
          {order.included && order.operations.length > 0 && (
            <details className={styles.operations}>
              <summary>{operationsText(order)}</summary>
              <ul>
                {order.operations.map((op) => (
                  <li key={op.moOperationId} data-locked={op.wasLocked ? "true" : undefined}>
                    {operationText(op)}
                    {op.started ? " · påbörjad" : ""}
                    {op.wasLocked ? " · var låst — planeras om" : ""}
                  </li>
                ))}
              </ul>
            </details>
          )}
        </div>
      </div>
    </li>
  );
}

"use client";

import { useEffect, useState } from "react";
import { Modal } from "../ui/Modal";
import { Button } from "../ui/Button";
import { Checkbox } from "../ui/Field";
import { FormActions, FormError, FormNotice } from "../ui/Form";
import { GatedLink } from "../ui/GatedLink";
import { HelpLink } from "../ui/HelpLink";
import { apiFetch, ApiError } from "../../lib/api";
import { apiErrorMessage } from "../../lib/errorMessages";
import { confirmDialog } from "../../lib/confirm";
import type { ComponentMovesResult, CoverageMove, CoverageMoveReason } from "../../lib/types";
import styles from "./Pegging.module.css";

const REASON_TEXT: Record<CoverageMoveReason, string> = {
  late: "Sen för ordern",
  needed_earlier: "Behövs tidigare",
  later_possible: "Kan bli klar senare",
  undated: "Saknar färdigdatum",
};

interface Props {
  open: boolean;
  onClose: () => void;
  orderId: string;
  moves: CoverageMove[];
  // Reloads the coverage (fresh rows after a 409).
  onReload: () => Promise<void>;
  // The card refreshes after a successful move.
  onMoved: () => void;
}

// Flytta halvfabrikaten: change the färdigdatum of the halvfabrikat TOs (the
// whole chain) so they are ready the working day before the need. Only the
// date moves — Planera lays the weeks out again.
export function MoveComponentsDialog(props: Props) {
  return (
    <Modal open={props.open} onClose={props.onClose} title="Flytta halvfabrikaten">
      <MoveComponentsForm {...props} />
    </Modal>
  );
}

function MoveComponentsForm({ onClose, orderId, moves, onReload, onMoved }: Props) {
  const initial = (): Record<string, boolean> => Object.fromEntries(moves.map((m) => [m.id, m.preselected]));
  const [selected, setSelected] = useState<Record<string, boolean>>(initial);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const [done, setDone] = useState<ComponentMovesResult | null>(null);

  // Fresh rows (after a 409) start from their own preselection.
  const signature = moves.map((m) => `${m.id}:${m.currentDueDate}:${m.suggestedDueDate}`).join("|");
  useEffect(() => {
    setSelected(Object.fromEntries(moves.map((m) => [m.id, m.preselected])));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [signature]);

  const byId = new Map(moves.map((m) => [m.id, m]));
  // A row counts only when it and every ancestor is ticked.
  const effective = (m: CoverageMove): boolean => {
    if (!selected[m.id]) return false;
    const parent = m.parentMoveId ? byId.get(m.parentMoveId) : undefined;
    return parent ? effective(parent) : true;
  };
  const chosen = moves.filter(effective);

  async function submit() {
    setError(null);
    if (chosen.length === 0) return;
    const text = `Ändra färdigdatum på ${chosen.length} ${chosen.length === 1 ? "tillverkningsorder" : "tillverkningsordrar"}?`;
    if (!(await confirmDialog(text, { confirmLabel: "Flytta" }))) return;
    setPending(true);
    try {
      const res = await apiFetch<ComponentMovesResult>(`/api/v1/manufacturing-orders/${orderId}/component-moves`, {
        method: "POST",
        body: JSON.stringify({
          moves: chosen.map((m) => ({
            manufacturingOrderId: m.manufacturingOrderId,
            dueDate: m.suggestedDueDate,
            expectedDueDate: m.currentDueDate,
          })),
        }),
      });
      setDone(res);
      onMoved();
    } catch (err) {
      setError(apiErrorMessage(err, "Kunde inte flytta halvfabrikaten"));
      if (err instanceof ApiError && err.status === 409) await onReload().catch(() => undefined);
    } finally {
      setPending(false);
    }
  }

  if (done) {
    return (
      <>
        <FormNotice role="status">{done.notice}</FormNotice>
        <FormActions>
          <Button type="button" variant="secondary" onClick={onClose}>
            Stäng
          </Button>
        </FormActions>
      </>
    );
  }

  return (
    <>
      <div className={styles.intro}>
        <span>Välj de halvfabrikat-TO:er som ska få nytt färdigdatum. Bara datumet ändras — kör Planera i Beläggning efteråt.</span>
        <HelpLink chapter="tillverkning" anchor="flytta-halvfabrikaten" label="Hjälp om Flytta halvfabrikaten" />
      </div>
      <FormError margin="below">{error}</FormError>
      {moves.length === 0 ? (
        <p>Inga halvfabrikat behöver flyttas.</p>
      ) : (
        <ul className={styles.list}>
          {moves.map((m) => {
            const parent = m.parentMoveId ? byId.get(m.parentMoveId) : undefined;
            const parentOn = parent ? effective(parent) : true;
            return (
              <li key={m.id} className={styles.item} style={{ marginLeft: Math.min(m.level - 1, 4) * 16 }} data-disabled={!parentOn}>
                <Checkbox
                  checked={effective(m)}
                  disabled={!parentOn}
                  aria-label={`Flytta ${m.orderNumber}`}
                  onChange={(e) => setSelected((s) => ({ ...s, [m.id]: e.target.checked }))}
                />
                <div className={styles.itemBody}>
                  <div>
                    <GatedLink href={`/tillverkning/ordrar/${m.manufacturingOrderId}`}>{m.orderNumber}</GatedLink>
                    <span className={styles.label}> · Artikel </span>
                    {m.articleNumber}
                  </div>
                  <div className={styles.dates}>
                    <span>
                      <span className={styles.label}>Nuvarande färdigdatum </span>
                      {m.currentDueDate ?? "saknas"}
                    </span>
                    <span>
                      → <span className={styles.label}>Föreslaget färdigdatum </span>
                      <strong>{m.suggestedDueDate}</strong>
                    </span>
                  </div>
                  <div className={styles.hints}>
                    <span>{REASON_TEXT[m.reason]}</span>
                    {!m.exclusive && <span>går också till andra behov</span>}
                    {m.late && <span className={styles.late}>hinner inte</span>}
                  </div>
                </div>
              </li>
            );
          })}
        </ul>
      )}
      <FormActions>
        <Button type="button" variant="secondary" onClick={onClose}>
          Avbryt
        </Button>
        <Button type="button" disabled={pending || chosen.length === 0} onClick={submit}>
          Flytta
        </Button>
      </FormActions>
    </>
  );
}

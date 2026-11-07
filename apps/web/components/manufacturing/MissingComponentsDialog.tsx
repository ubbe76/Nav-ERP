"use client";

import { useEffect, useState } from "react";
import { Modal } from "../ui/Modal";
import { Button } from "../ui/Button";
import { FormActions, FormError, FormNotice } from "../ui/Form";
import { GatedLink } from "../ui/GatedLink";
import { HelpLink } from "../ui/HelpLink";
import { apiFetch, ApiError } from "../../lib/api";
import { apiErrorMessage } from "../../lib/errorMessages";
import { formatQuantity } from "../../lib/format";
import type { CreateMissingComponentsResult, MissingComponentsPreview } from "../../lib/types";
import styles from "./Pegging.module.css";

interface Props {
  open: boolean;
  onClose: () => void;
  orderId: string;
  onCreated: () => void;
}

// Skapa saknade halvfabrikat: the whole structure of manufactured components
// nothing covers, created in one go (children before parents).
export function MissingComponentsDialog(props: Props) {
  return (
    <Modal open={props.open} onClose={props.onClose} title="Skapa saknade halvfabrikat">
      <MissingComponentsForm {...props} />
    </Modal>
  );
}

function MissingComponentsForm({ onClose, orderId, onCreated }: Props) {
  const [preview, setPreview] = useState<MissingComponentsPreview | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const [created, setCreated] = useState<CreateMissingComponentsResult | null>(null);

  useEffect(() => {
    let cancelled = false;
    apiFetch<MissingComponentsPreview>(`/api/v1/manufacturing-orders/${orderId}/missing-components`)
      .then((p) => {
        if (!cancelled) setPreview(p);
      })
      .catch((err) => {
        if (!cancelled) setError(apiErrorMessage(err, "Kunde inte läsa förhandsvisningen"));
      });
    return () => {
      cancelled = true;
    };
  }, [orderId]);

  async function submit() {
    if (!preview || preview.orders.length === 0) return;
    setError(null);
    setPending(true);
    try {
      const res = await apiFetch<CreateMissingComponentsResult>(`/api/v1/manufacturing-orders/${orderId}/missing-components`, {
        method: "POST",
        body: JSON.stringify({
          expected: preview.orders.map((o) => ({ articleId: o.articleId, quantity: o.quantity, level: o.level })),
        }),
      });
      setCreated(res);
      onCreated();
    } catch (err) {
      setError(apiErrorMessage(err, "Kunde inte skapa tillverkningsordrarna"));
      if (err instanceof ApiError && err.status === 409) {
        // The 409 body carries the new preview as `result`.
        const body = err.body as { result?: MissingComponentsPreview } | undefined;
        if (body?.result) setPreview(body.result);
      }
    } finally {
      setPending(false);
    }
  }

  if (created) {
    return (
      <>
        <FormNotice role="status">
          Skapade {created.manufacturingOrders.length} {created.manufacturingOrders.length === 1 ? "tillverkningsorder" : "tillverkningsordrar"}.
        </FormNotice>
        <ul className={styles.notes}>
          {created.manufacturingOrders.map((mo) => (
            <li key={mo.id}>
              <GatedLink href={`/tillverkning/ordrar/${mo.id}`}>{mo.orderNumber}</GatedLink> · {mo.articleNumber} ·{" "}
              {formatQuantity(mo.quantity)}
            </li>
          ))}
        </ul>
        {created.warnings.length > 0 && (
          <FormNotice>
            <ul style={{ margin: 0, paddingLeft: 18 }}>
              {created.warnings.map((w, i) => (
                <li key={i}>{w}</li>
              ))}
            </ul>
          </FormNotice>
        )}
        <FormActions>
          <Button type="button" variant="secondary" onClick={onClose}>
            Stäng
          </Button>
        </FormActions>
      </>
    );
  }

  const rows = preview?.orders ?? [];
  return (
    <>
      <div className={styles.intro}>
        <span>Tillverkningsordrar för de tillverkade halvfabrikat som ingenting täcker, hela strukturen på en gång.</span>
        <HelpLink chapter="tillverkning" anchor="skapa-saknade-halvfabrikat" label="Hjälp om Skapa saknade halvfabrikat" />
      </div>
      <FormError margin="below">{error}</FormError>
      {!preview && !error && <p>Läser in…</p>}
      {preview && rows.length === 0 && <p>Det finns inga tillverkningsordrar att skapa.</p>}
      {rows.length > 0 && (
        <ul className={styles.list}>
          {rows.map((o) => (
            <li key={o.key} className={styles.item} style={{ marginLeft: Math.min(o.level - 1, 4) * 16 }}>
              <div className={styles.itemBody}>
                <div>
                  <strong>{o.articleNumber}</strong> · {o.articleName}
                </div>
                <div className={styles.dates}>
                  <span>
                    <span className={styles.label}>Antal </span>
                    {formatQuantity(o.quantity)}
                  </span>
                  <span>
                    <span className={styles.label}>Färdigdatum </span>
                    {o.dueDate ?? "saknar datum"}
                    {o.late && <span className={styles.late}> · hinner inte</span>}
                  </span>
                </div>
              </div>
            </li>
          ))}
        </ul>
      )}
      {preview && preview.notes.length > 0 && (
        <ul className={styles.notes}>
          {preview.notes.map((n, i) => (
            <li key={i}>{n}</li>
          ))}
        </ul>
      )}
      <FormActions>
        <Button type="button" variant="secondary" onClick={onClose}>
          Avbryt
        </Button>
        {rows.length > 0 && (
          <Button type="button" disabled={pending} onClick={submit}>
            Skapa {rows.length} {rows.length === 1 ? "tillverkningsorder" : "tillverkningsordrar"}
          </Button>
        )}
      </FormActions>
    </>
  );
}

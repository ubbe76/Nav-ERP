"use client";

import { useEffect, useRef, useState } from "react";
import { Button } from "../ui/Button";
import { Checkbox } from "../ui/Field";
import { FormActions, FormError, FormHint, FormNotice } from "../ui/Form";
import { GatedLink } from "../ui/GatedLink";
import { Modal } from "../ui/Modal";
import { DeliveryTimeCheckResult } from "./DeliveryTimeCheckResult";
import { applyDeliveryTime, runDeliveryTimeCheck, type DeliveryTimeCheckRequest } from "../../lib/deliveryTimeCheck";
import { ApiError } from "../../lib/api";
import { apiErrorMessage } from "../../lib/errorMessages";
import type { ApplyDeliveryTimeResult, DeliveryTimeCheckResult as Result } from "../../lib/types";
import styles from "./DeliveryTimeCheckDialog.module.css";

// Runs Leveranstidskontroll when it opens and shows the result. "Använd
// datumet" (only when the check found a delivery date) hands the date back to
// the caller, which decides where it goes (order header or the new-order form).
//
// From a saved order card (request.salesOrderId) a result with shortage
// batches also offers "Skapa tillverkningsordrar för det som saknas": the
// date is then applied by the reservation endpoint, which creates the
// manufacturing orders in the weeks the check counted and sets the order's
// expected delivery date in one transaction — onUseDate is not called.
export function DeliveryTimeCheckDialog({
  open,
  onClose,
  request,
  withCustomer,
  onUseDate,
  useDateBusy = false,
  useDateError = null,
  onApplied,
  canCreateOrders = false,
}: {
  open: boolean;
  onClose: () => void;
  // Read when the dialog opens.
  request: DeliveryTimeCheckRequest;
  withCustomer: boolean;
  onUseDate: (date: string) => void;
  useDateBusy?: boolean;
  useDateError?: string | null;
  // The reservation went through (the order card reloads its rows).
  onApplied?: () => void;
  // Only a confirmed order (or one in production) can get linked TOs — the
  // API refuses a quote (sales-order-not-open), so the box is not offered.
  canCreateOrders?: boolean;
}) {
  const [result, setResult] = useState<Result | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [reserve, setReserve] = useState(true);
  const [applying, setApplying] = useState(false);
  const [applyError, setApplyError] = useState<string | null>(null);
  const [changedNotice, setChangedNotice] = useState<string | null>(null);
  const [applied, setApplied] = useState<ApplyDeliveryTimeResult | null>(null);
  const requestRef = useRef(request);
  requestRef.current = request;

  useEffect(() => {
    if (!open) return;
    let active = true;
    setResult(null);
    setError(null);
    setLoading(true);
    setReserve(true);
    setApplyError(null);
    setChangedNotice(null);
    setApplied(null);
    runDeliveryTimeCheck(requestRef.current)
      .then((r) => {
        if (active) setResult(r);
      })
      .catch((err) => {
        if (active) setError(apiErrorMessage(err, "Kunde inte kontrollera leveranstiden"));
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, [open]);

  const salesOrderId = request.salesOrderId;
  const batchCount = result?.batches?.length ?? 0;
  const canReserve = canCreateOrders && withCustomer && !!salesOrderId && batchCount > 0;

  async function applyReservation(orderId: string, deliveryDate: string, expectedOrders: number) {
    setApplyError(null);
    setChangedNotice(null);
    setApplying(true);
    try {
      const res = await applyDeliveryTime({ salesOrderId: orderId, deliveryDate, expectedOrders });
      setApplied(res);
      onApplied?.();
    } catch (err) {
      const newResult = err instanceof ApiError && err.code === "delivery-time-changed" ? changedResult(err) : null;
      if (newResult) {
        // Someone booked capacity in between: show the new check and let the
        // user decide again.
        setResult(newResult);
        setChangedNotice(
          newResult.deliveryDate
            ? `Läget har ändrats sedan kontrollen — det nya datumet är ${newResult.deliveryDate}`
            : "Läget har ändrats sedan kontrollen — kontrollen hittar inget datum längre"
        );
      } else {
        setApplyError(apiErrorMessage(err, "Kunde inte skapa tillverkningsordrarna"));
      }
    } finally {
      setApplying(false);
    }
  }

  function useDate(date: string) {
    if (canReserve && reserve && salesOrderId) {
      void applyReservation(salesOrderId, date, batchCount);
      return;
    }
    onUseDate(date);
  }

  const busy = useDateBusy || applying;

  return (
    <Modal open={open} onClose={onClose} title="Leveranstidskontroll" wide>
      <FormError>{error}</FormError>
      <FormError>{useDateError}</FormError>
      <FormError>{applyError}</FormError>
      {changedNotice && <FormNotice>{changedNotice}</FormNotice>}
      {loading && <FormHint>Kontrollerar…</FormHint>}
      {result && <DeliveryTimeCheckResult result={result} withCustomer={withCustomer} />}
      {result && !withCustomer && <FormHint>Välj kund för att räkna med kundens transportdagar.</FormHint>}

      {canReserve && !applied && (
        <label className={styles.reserve}>
          <Checkbox checked={reserve} disabled={busy} onChange={(e) => setReserve(e.target.checked)} />
          <span>Skapa tillverkningsordrar för det som saknas ({batchCount} st)</span>
        </label>
      )}

      {applied && (
        <>
          <p className={styles.appliedTitle}>
            Leveransdatum satt till {applied.deliveryDate}.{" "}
            {applied.manufacturingOrders.length > 0
              ? applied.manufacturingOrders.length === 1
                ? "1 tillverkningsorder skapad:"
                : `${applied.manufacturingOrders.length} tillverkningsordrar skapade:`
              : "Inga tillverkningsordrar behövde skapas."}
          </p>
          {applied.manufacturingOrders.length > 0 && (
            <ul className={styles.created}>
              {applied.manufacturingOrders.map((mo) => (
                <li key={mo.id} className={styles.createdRow}>
                  <GatedLink href={`/tillverkning/ordrar/${mo.id}`} className={styles.createdLink}>
                    {mo.orderNumber}
                  </GatedLink>{" "}
                  <span className={styles.createdMeta}>
                    {mo.articleNumber} · {mo.quantity} st{mo.level > 1 ? " · halvfabrikat" : ""}
                  </span>
                </li>
              ))}
            </ul>
          )}
          {applied.warnings.map((w, i) => (
            <FormNotice key={i}>{typeof w === "string" ? w : w.message}</FormNotice>
          ))}
        </>
      )}

      <FormActions>
        {withCustomer && result?.deliveryDate && !applied && (
          <Button type="button" variant="primary" disabled={busy} onClick={() => useDate(result.deliveryDate!)}>
            {busy ? "Sparar…" : "Använd datumet"}
          </Button>
        )}
        <Button type="button" variant="secondary" onClick={onClose}>
          Stäng
        </Button>
      </FormActions>
    </Modal>
  );
}

// The 409 delivery-time-changed body carries the fresh check as `result`.
function changedResult(err: ApiError): Result | null {
  const body = err.body as { result?: Result } | undefined;
  return body?.result ?? null;
}

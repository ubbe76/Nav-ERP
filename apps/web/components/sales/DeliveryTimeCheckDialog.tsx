"use client";

import { useEffect, useRef, useState } from "react";
import { Button } from "../ui/Button";
import { FormActions, FormError, FormHint } from "../ui/Form";
import { Modal } from "../ui/Modal";
import { DeliveryTimeCheckResult } from "./DeliveryTimeCheckResult";
import { runDeliveryTimeCheck, type DeliveryTimeCheckRequest } from "../../lib/deliveryTimeCheck";
import { apiErrorMessage } from "../../lib/errorMessages";
import type { DeliveryTimeCheckResult as Result } from "../../lib/types";

// Runs Leveranstidskontroll when it opens and shows the result. "Använd
// datumet" (only when the check found a delivery date) hands the date back to
// the caller, which decides where it goes (order header or the new-order form).
export function DeliveryTimeCheckDialog({
  open,
  onClose,
  request,
  withCustomer,
  onUseDate,
  useDateBusy = false,
  useDateError = null,
}: {
  open: boolean;
  onClose: () => void;
  // Read when the dialog opens.
  request: DeliveryTimeCheckRequest;
  withCustomer: boolean;
  onUseDate: (date: string) => void;
  useDateBusy?: boolean;
  useDateError?: string | null;
}) {
  const [result, setResult] = useState<Result | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const requestRef = useRef(request);
  requestRef.current = request;

  useEffect(() => {
    if (!open) return;
    let active = true;
    setResult(null);
    setError(null);
    setLoading(true);
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

  return (
    <Modal open={open} onClose={onClose} title="Leveranstidskontroll" wide>
      <FormError>{error}</FormError>
      <FormError>{useDateError}</FormError>
      {loading && <FormHint>Kontrollerar…</FormHint>}
      {result && <DeliveryTimeCheckResult result={result} withCustomer={withCustomer} />}
      <FormActions>
        {result?.deliveryDate && (
          <Button type="button" variant="primary" disabled={useDateBusy} onClick={() => onUseDate(result.deliveryDate!)}>
            {useDateBusy ? "Sparar…" : "Använd datumet"}
          </Button>
        )}
        <Button type="button" variant="secondary" onClick={onClose}>
          Stäng
        </Button>
      </FormActions>
    </Modal>
  );
}

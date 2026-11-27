"use client";

import { useState } from "react";
import { Button } from "../ui/Button";
import { FormError } from "../ui/Form";
import { useCan } from "../PermissionsProvider";
import { DeliveryTimeCheckDialog } from "./DeliveryTimeCheckDialog";
import type { DeliveryTimeCheckRequest } from "../../lib/deliveryTimeCheck";
import { ESTIMATE_COUNTING, estimateErrorLine, estimateKey, estimateLine } from "../../lib/deliveryTimeBox";
import { useDeliveryTimeEstimate } from "../../lib/useDeliveryTimeEstimate";
import styles from "./DeliveryTimeBox.module.css";

// The Leveranstid box: an estimate from Leveranstidskontroll (books nothing)
// that follows the rows. It never fills a date field by itself — only the
// click on "Använd datumet" hands the date on. request = null: no valid rows,
// nothing is asked.
export function DeliveryTimeBox({
  request,
  withCustomer,
  onUseDate,
  useDateBusy = false,
  useDateError = null,
  rowsWithOwnDate = 0,
  refreshKey = "",
}: {
  request: DeliveryTimeCheckRequest | null;
  withCustomer: boolean;
  onUseDate: (date: string) => void;
  // A caller whose "Använd datumet" writes (the quote card's PATCH): the
  // button waits while it is under way, and a failure is shown HERE — the
  // box's own dialog is closed by then.
  useDateBusy?: boolean;
  useDateError?: string | null;
  rowsWithOwnDate?: number;
  // The quote card asks with { salesOrderId } only, so the request never
  // changes when the rows do: the card hands in its rows, customer and
  // revision here, and a change counts again.
  refreshKey?: string;
}) {
  const can = useCan();
  const allowed = can(["forsaljning", "tillverkning"]);
  const effective = allowed ? request : null;
  const estimate = useDeliveryTimeEstimate(effective, effective ? `${estimateKey(effective)}|${refreshKey}` : "");
  const [open, setOpen] = useState(false);

  if (!allowed || !request) return null;

  const counting = estimate.state === "waiting" || estimate.state === "loading";
  const line = estimate.result ? estimateLine(estimate.result, withCustomer) : null;
  const failed = estimate.state === "error";

  return (
    <div className={styles.box} aria-live="polite">
      <div className={styles.label}>Leveranstid</div>
      <div className={styles.body} data-dim={counting && line ? "true" : undefined}>
        {failed ? (
          <span className={styles.hint}>{estimateErrorLine(estimate.errorCode, estimate.error)}</span>
        ) : line ? (
          <>
            <span className={styles.main} data-none={line.date ? undefined : "true"}>
              {line.text}
            </span>
            {line.alternative && <span className={styles.hint}>{line.alternative}</span>}
          </>
        ) : (
          <span className={styles.hint}>{ESTIMATE_COUNTING}</span>
        )}
        {counting && line && <span className={styles.hint}>{ESTIMATE_COUNTING}</span>}
      </div>
      <div className={styles.actions}>
        <Button
          type="button"
          variant="secondary"
          size="small"
          disabled={!line?.date || counting || failed || useDateBusy}
          onClick={() => line?.date && onUseDate(line.date)}
        >
          {useDateBusy ? "Sparar…" : "Använd datumet"}
        </Button>
        <Button type="button" variant="secondary" size="small" onClick={() => setOpen(true)}>
          Visa hur
        </Button>
      </div>
      {useDateError && (
        <div className={styles.error}>
          <FormError>{useDateError}</FormError>
        </div>
      )}
      <DeliveryTimeCheckDialog
        open={open}
        onClose={() => setOpen(false)}
        request={request}
        withCustomer={withCustomer}
        rowsWithOwnDate={rowsWithOwnDate}
        useDateBusy={useDateBusy}
        onUseDate={(date) => {
          setOpen(false);
          onUseDate(date);
        }}
      />
    </div>
  );
}

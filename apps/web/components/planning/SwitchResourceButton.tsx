"use client";

import { useState } from "react";
import { Button } from "../ui/Button";
import { apiFetch } from "../../lib/api";
import { apiErrorMessage } from "../../lib/errorMessages";

// Alternativa resurser (#15, etapp 2): Byt till X. Planera only suggests; the
// switch is made by hand — PATCH …/operations/:opId { workCenterId } puts the
// operation in the suggestion's week and makes it Vald för hand. The caller
// hides the button without Tillverkning (useCan) and reloads on success.
// expectedWorkCenterId = the resource the förslag was made for: a switch on
// an operation that changed resource or was moved meanwhile is refused (409
// mo-operation-resource-changed) instead of switching blind.
export function SwitchResourceButton({
  manufacturingOrderId,
  moOperationId,
  fromWorkCenterId,
  workCenterId,
  code,
  onSwitched,
  onError,
}: {
  manufacturingOrderId: string;
  moOperationId: string;
  fromWorkCenterId: string; // the operation's current resource, as the förslag saw it
  workCenterId: string;
  code: string;
  onSwitched: () => void;
  onError: (message: string | null) => void;
}) {
  const [busy, setBusy] = useState(false);

  async function run() {
    setBusy(true);
    onError(null);
    try {
      await apiFetch(`/api/v1/manufacturing-orders/${manufacturingOrderId}/operations/${moOperationId}`, {
        method: "PATCH",
        body: JSON.stringify({ workCenterId, expectedWorkCenterId: fromWorkCenterId }),
      });
      onSwitched();
    } catch (err) {
      onError(apiErrorMessage(err, "Kunde inte byta resurs"));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Button type="button" variant="secondary" size="small" disabled={busy} onClick={run}>
      {busy ? "Byter…" : `Byt till ${code}`}
    </Button>
  );
}

import { confirmDialog } from "./confirm";
import { apiFetch } from "./api";
import type { ManufacturingOrderStatus } from "./types";

// The body-less status transitions of a manufacturing order (TO), shared by
// the TO card's action buttons and the TO list's row/bulk actions so both
// surfaces use the same labels and endpoints.
export type OrderAction = "release" | "cancel" | "close";

export const ACTION_LABELS: Record<OrderAction, { label: string; endpoint: string; variant: "primary" | "danger" }> = {
  release: { label: "Frisläpp", endpoint: "release", variant: "primary" },
  cancel: { label: "Makulera order", endpoint: "cancel", variant: "danger" },
  close: { label: "Stäng order", endpoint: "close", variant: "primary" },
};

// Which transitions a status offers, mirroring the service's state machine
// (planned → released → in_progress → done → closed). There is no Starta: an
// order is under way from its first report. Makulera works while the order is
// open — the server refuses it while anything is booked against the order
// (the reports are undone first). `complete` is deliberately absent: it takes
// a stock location and a quantity and books a receipt, so it stays a form on
// the card rather than a one-click action.
export function actionsForStatus(status: ManufacturingOrderStatus): OrderAction[] {
  switch (status) {
    case "planned":
      return ["release", "cancel"];
    case "released":
    case "in_progress":
      return ["cancel"];
    case "done":
      return ["close"];
    default:
      return [];
  }
}

// Release answers with stock-shortage warnings; the other actions answer with
// the updated order. Callers only care about the warnings.
export async function runOrderAction(orderId: string, action: OrderAction): Promise<string[]> {
  const response = await apiFetch<unknown>(`/api/v1/manufacturing-orders/${orderId}/${ACTION_LABELS[action].endpoint}`, {
    method: "POST",
  });
  if (response && typeof response === "object" && "warnings" in response) {
    const { warnings } = response as { warnings: unknown };
    if (Array.isArray(warnings)) return warnings.filter((w): w is string => typeof w === "string");
  }
  return [];
}

// Makulera is the one irreversible action here — a cancelled TO cannot be
// reopened — so both surfaces ask first, with the same wording.
export function confirmCancel(orderNumbers: string[]): Promise<boolean> {
  const what = orderNumbers.length === 1 ? orderNumbers[0] : `${orderNumbers.length} tillverkningsordrar`;
  return confirmDialog(`Makulera ${what}? En makulerad order kan inte återöppnas.`, {
    confirmLabel: "Makulera",
    danger: true,
  });
}

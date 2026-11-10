// Konfigurator 4c: how much of a configured (beställningsvara) sales order row
// still needs a TO. Pure. The template's stock is shared by every
// configuration, so a unit in stock is never assumed to match this row —
// only TOs linked to the row and what has already left on the row count.
//   uncovered = max(0, ordered − open − max(delivered, finished))
// open = what the linked open TOs (planned/released/in_progress) have yet
// to receive (quantity − received, never below 0),
// finished = linked TOs done/closed plus what the open ones have already
// received (those units are either still in stock for this row or already
// delivered — counted once via the max). Before the received part counted
// as finished, a partly received open TO was counted twice: its full
// quantity as open AND its delivered units in `delivered` (review
// 2026-11-10).
// `received` is manufacturing_orders.quantity_received.
const OPEN = new Set(["planned", "released", "in_progress"]);
const FINISHED = new Set(["done", "closed"]);
const round4 = (n: number) => Number(n.toFixed(4));

export function uncoveredConfiguredQuantity(input: {
  quantityOrdered: number;
  quantityDelivered: number;
  linkedOrders: { status: string; quantity: number; received: number }[];
}): number {
  let open = 0;
  let finished = 0;
  for (const o of input.linkedOrders) {
    if (OPEN.has(o.status)) {
      open += Math.max(0, o.quantity - o.received);
      finished += o.received;
    } else if (FINISHED.has(o.status)) finished += o.quantity;
  }
  return Math.max(0, round4(input.quantityOrdered - open - Math.max(input.quantityDelivered, finished)));
}

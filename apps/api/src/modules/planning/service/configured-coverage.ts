// Konfigurator 4c: how much of a configured (beställningsvara) sales order row
// still needs a TO. Pure. The template's stock is shared by every
// configuration, so a unit in stock is never assumed to match this row —
// only TOs linked to the row and what has already left on the row count.
//   uncovered = max(0, ordered − open − max(delivered, finished))
// open = linked TOs not yet reported (planned/released/in_progress),
// finished = linked TOs done/closed (their units are either still in stock
// for this row or already delivered — counted once via the max).
const OPEN = new Set(["planned", "released", "in_progress"]);
const FINISHED = new Set(["done", "closed"]);
const round4 = (n: number) => Number(n.toFixed(4));

export function uncoveredConfiguredQuantity(input: {
  quantityOrdered: number;
  quantityDelivered: number;
  linkedOrders: { status: string; quantity: number }[];
}): number {
  let open = 0;
  let finished = 0;
  for (const o of input.linkedOrders) {
    if (OPEN.has(o.status)) open += o.quantity;
    else if (FINISHED.has(o.status)) finished += o.quantity;
  }
  return Math.max(0, round4(input.quantityOrdered - open - Math.max(input.quantityDelivered, finished)));
}

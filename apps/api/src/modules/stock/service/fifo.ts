// FIFO-värdering (först in, först ut) for the valuation report (#19, the
// FIFO part). Pure — the service feeds it one article's stock_transactions
// rows in värderingsdatum order (#26) and gets the quantity on hand and the
// FIFO unit cost back. Nothing is stored: the log is the record, exactly as
// for the moving average (moving-average.ts).
//
// Under FIFO the oldest stock leaves first, so what is left on a date is the
// NEWEST inflows, back until the quantity on hand is covered. Outflows never
// need to be matched to layers one by one: the remaining quantity is the sum
// of every delta, and it is priced from the newest layers backwards.

export interface FifoRow {
  quantityDelta: number;
  // SEK per unit, stamped on inflows only (D0); null = unknown, 0 = free.
  unitCost: number | null;
  // layer    — a real inflow: a receipt that was not undone, a TO receipt,
  //            a positive adjustment, a stock count, a stock-balance import;
  // reversal — the undo of a layer (a negative TO receipt row): takes its
  //            quantity back from the newest earlier layer with the same key;
  // other    — everything else: outflows, transfers (no valuation event),
  //            the return of an outflow (an undone delivery or draw), an
  //            undone purchase receipt and its reversal.
  kind: "layer" | "reversal" | "other";
  // Matches a reversal to its layer (type + document); ignored for other.
  key?: string;
}

export interface FifoResult {
  quantity: number;
  // null when no priced layer exists — a price cannot be invented.
  unitCost: number | null;
}

export function computeFifo(rows: FifoRow[]): FifoResult {
  let quantity = 0;
  const layers: { quantity: number; unitCost: number | null; key?: string }[] = [];

  for (const row of rows) {
    quantity = round4(quantity + row.quantityDelta);
    if (row.kind === "layer" && row.quantityDelta > 0) {
      layers.push({ quantity: row.quantityDelta, unitCost: row.unitCost, key: row.key });
    } else if (row.kind === "reversal" && row.quantityDelta < 0) {
      // Newest matching layer first — the undo of a receipt reverses that
      // receipt; when several share a key (two receipts on one TO) the
      // newest is taken, an accepted approximation (both carry the
      // article's standard cost of their moment).
      let remaining = -row.quantityDelta;
      for (let i = layers.length - 1; i >= 0 && remaining > 0; i--) {
        const layer = layers[i]!;
        if (layer.key !== row.key || layer.quantity <= 0) continue;
        const taken = Math.min(layer.quantity, remaining);
        layer.quantity = round4(layer.quantity - taken);
        remaining = round4(remaining - taken);
      }
    }
  }

  if (quantity <= 0) {
    // Nothing (or less than nothing) on hand: the price the next inflow
    // would be compared with is the newest priced layer's.
    for (let i = layers.length - 1; i >= 0; i--) {
      if (layers[i]!.unitCost !== null) return { quantity, unitCost: layers[i]!.unitCost };
    }
    return { quantity, unitCost: null };
  }

  // Newest layers back until the quantity is covered. An unpriced layer is
  // skipped — its cost is unknown, not free (the moving average's rule): the
  // quantity is priced from the priced layers around it. Quantity the priced
  // layers cannot cover (stock from before costs were recorded) is valued at
  // the average of the layers that were taken.
  let remaining = quantity;
  let takenQuantity = 0;
  let takenCost = 0;
  for (let i = layers.length - 1; i >= 0 && remaining > 0; i--) {
    const layer = layers[i]!;
    if (layer.unitCost === null || layer.quantity <= 0) continue;
    const taken = Math.min(layer.quantity, remaining);
    takenQuantity = round4(takenQuantity + taken);
    takenCost += taken * layer.unitCost;
    remaining = round4(remaining - taken);
  }
  if (takenQuantity === 0) return { quantity, unitCost: null };
  // Four decimals (numeric(14,4), like the standard cost): the report's value
  // is round2(quantity × unitCost), and a two-decimal unit cost would put öre
  // errors on top of an exact FIFO value.
  return { quantity, unitCost: round4(takenCost / takenQuantity) };
}

// Quantities live in numeric(14,4) — same local helper as moving-average.ts.
function round4(n: number): number {
  return Math.round((n + Number.EPSILON) * 10000) / 10000;
}

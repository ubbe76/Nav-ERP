import { round4 } from "./format";
import type { ArticleOverviewRow } from "./types";

// The artikelöversikt's planned view with the quantities typed into the
// Behovsberäkning page (user's goal 2026-11-24: see the demand a proposal is
// ordered against). The server's rows carry the behovsberäkning's own
// quantities; here a typed quantity replaces a proposal row's, and a
// proposal's material (derived_demand) is rescaled by typed ÷ proposed — the
// explosion is linear, so that is exactly the material the order Skapa
// ordrar makes would need. Proposals further up are not followed: the parent
// order is created with the parent's own typed quantity.

export interface PlannedDisplayRow extends ArticleOverviewRow {
  // The server's quantity when a typed one replaced it (shown as a hint).
  proposedQuantity?: number;
}

// The page's typed quantities per proposal key: only a field that holds a
// number ≥ 0 counts (an empty field mid-edit shows the proposal).
export function typedQuantities(states: Iterable<{ proposalKey: string | null; quantity: string; touched: boolean }>): Map<string, number> {
  const typed = new Map<string, number>();
  for (const s of states) {
    if (!s.touched || s.proposalKey === null || s.quantity.trim() === "") continue;
    const q = Number(s.quantity);
    if (Number.isFinite(q) && q >= 0) typed.set(s.proposalKey, q);
  }
  return typed;
}

// The rows with the typed quantities and the running balance recomputed from
// onHand in the server's order (a quantity never moves a row).
export function withTypedQuantities(
  onHand: number,
  rows: readonly ArticleOverviewRow[],
  typed: ReadonlyMap<string, number>
): { rows: PlannedDisplayRow[]; closingBalance: number } {
  let balance = onHand;
  const out = rows.map((row): PlannedDisplayRow => {
    let quantity = row.quantity;
    const own = row.proposal ? typed.get(row.proposal.key) : undefined;
    const source = row.sourceProposal;
    const parent = source ? typed.get(source.key) : undefined;
    if (own !== undefined) quantity = own;
    else if (source && parent !== undefined && source.quantity > 0) quantity = round4((row.quantity * parent) / source.quantity);
    balance = round4(balance + quantity);
    if (quantity === row.quantity && balance === row.balance) return row;
    return { ...row, quantity, balance, ...(quantity !== row.quantity ? { proposedQuantity: row.quantity } : {}) };
  });
  return { rows: out, closingBalance: balance };
}

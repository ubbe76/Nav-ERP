// Prishistorik as of a moment — what a price WAS when the material was taken
// out, for the efterkalkyl. Pure: the repository hands in the history rows
// (ascending by validFrom) and gets the value back, so the rule is testable
// without a database.
//
// One convention for every history, the one the stock valuation already uses
// for the standard cost (D1): the latest row valid at the moment; before the
// first row, the first row — "the price before any known price is the first
// one we ever recorded", never an invented one. Histories start at their
// migration, so an order consumed earlier is priced at that first value.

export interface StandardCostHistoryRow {
  cost: string;
  validFrom: Date;
}

export interface SupplierSnapshotRow {
  supplierId: string | null;
  price: string | null;
  currency: string;
  priceBreaks: { fromQuantity: number; price: number }[];
  isPrimary: boolean;
  removed: boolean;
  validFrom: Date;
}

function latestAt<T extends { validFrom: Date }>(rows: T[], at: Date): T | undefined {
  let found: T | undefined;
  for (const row of rows) {
    if (row.validFrom.getTime() <= at.getTime()) found = row;
    else break;
  }
  return found;
}

export function standardCostAt(rows: StandardCostHistoryRow[], at: Date): string | null {
  if (rows.length === 0) return null;
  return (latestAt(rows, at) ?? rows[0]!).cost;
}

// The primary supplier's catalog row as it stood at `at`: each supplier's
// latest snapshot by then, and of those the one that was primary and still in
// the catalog. Before the article's first snapshot, each supplier's first one.
export function primarySupplierAt(rows: SupplierSnapshotRow[], at: Date): SupplierSnapshotRow | null {
  if (rows.length === 0) return null;
  const beforeHistory = rows[0]!.validFrom.getTime() > at.getTime();
  const bySupplier = new Map<string | null, SupplierSnapshotRow[]>();
  for (const row of rows) {
    const list = bySupplier.get(row.supplierId);
    if (list) list.push(row);
    else bySupplier.set(row.supplierId, [row]);
  }
  for (const list of bySupplier.values()) {
    const state = beforeHistory ? list[0] : latestAt(list, at);
    if (state && state.isPrimary && !state.removed) return state;
  }
  return null;
}

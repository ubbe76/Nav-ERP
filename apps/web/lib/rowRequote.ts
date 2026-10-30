import { toBaseQuantity } from "./units";

// Ändra on an order row ("manuellt vinner"): when the quantity changes and
// the operator hasn't typed a price, the card asks for the price again — the
// sales order's price chain, the purchase order's stafflade leverantörspris.
// One rule for both cards (test/web-row-requote.test.ts):
// - the base quantity the shown price belongs to is remembered (the row's own
//   at first, then each quoted one), so 10 → 100 → 10 comes back to the
//   10-tier and a pure unit switch (same base quantity) never reprices;
// - until the article's units have loaded, a row entered in another unit has
//   no known factor — quoting then would read 500 kg as 500 base units and
//   overwrite the stored price just by opening Ändra.
// Null = no quote; otherwise the base quantity to quote and the factor to
// show the answer in. The caller remembers `base` as soon as it asks.
export function requoteFor(input: {
  quantity: string;
  unitId: string; // "" = the article's base unit
  unitOptions: { value: string; factor: number }[];
  pricedBaseQuantity: number;
}): { base: number; factor: number } | null {
  const quantity = Number(input.quantity);
  if (!Number.isFinite(quantity) || quantity <= 0) return null;
  const factor = input.unitId === "" ? 1 : input.unitOptions.find((o) => o.value === input.unitId)?.factor;
  if (factor === undefined) return null;
  const base = toBaseQuantity(quantity, factor);
  return base === input.pricedBaseQuantity ? null : { base, factor };
}

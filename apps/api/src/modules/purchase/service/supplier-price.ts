// Stafflade leverantörspriser — pure resolution of a catalog row's price for
// a quantity. No DB imports: the repository loads the row and its breaks,
// this module owns the rule, so the three consumers (IO-row prefill,
// behovsberäkningens Skapa ordrar, the cost calculation) cannot disagree.
//
// Model: `article_suppliers.price` is the grundpris — the price for quantity
// 1 — and every break is an ABSOLUTE price valid from its from_quantity
// (> 1). The highest break <= quantity wins; without a matching break the
// grundpris applies. A matching break wins even when the grundpris is null.
// Prices are in the article's base unit and the catalog row's currency.
export interface PriceBreak {
  fromQuantity: number;
  price: number;
}

export interface SupplierPriceBasis {
  price: number | null;
  priceBreaks: PriceBreak[];
}

export type SupplierPriceSource = "break" | "base";

export interface ResolvedSupplierPrice {
  price: number | null;
  // 1 for the grundpris, the break's own from_quantity otherwise.
  fromQuantity: number | null;
  source: SupplierPriceSource | null;
}

export function resolveSupplierPrice(basis: SupplierPriceBasis, quantity: number): ResolvedSupplierPrice {
  // Breaks are not assumed sorted — the web form sends them in entry order.
  let best: PriceBreak | null = null;
  if (Number.isFinite(quantity) && quantity > 0) {
    for (const step of basis.priceBreaks) {
      if (step.fromQuantity <= quantity && (best === null || step.fromQuantity > best.fromQuantity)) {
        best = step;
      }
    }
  }
  if (best) return { price: best.price, fromQuantity: best.fromQuantity, source: "break" };
  if (basis.price !== null) return { price: basis.price, fromQuantity: 1, source: "base" };
  return { price: null, fromQuantity: null, source: null };
}

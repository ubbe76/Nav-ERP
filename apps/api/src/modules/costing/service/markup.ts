import type { CostingMaterialSource, CostingSupplierPriceTier, CostPriceSource } from "@navet/shared";
import { resolveSupplierPrice, type PriceBreak } from "../../purchase/service/supplier-price.js";

// Monitor's påläggskalkyl, as pure arithmetic — no DB, no settings lookup, so
// the chain can be tested on its own. TO (tillverkningsomkostnad) is not a
// markup percentage here: it already sits per work center on
// work_centers.overhead_percent and arrives as `overhead`.
export interface CostingMarkups {
  // MO = materialomkostnader, on direct material.
  moPercent: number;
  // LO = legoomkostnader, on subcontracted work.
  loPercent: number;
  // Affo = affärsomkostnader, on the manufacturing cost (TVK).
  affoPercent: number;
  // Vinstpålägg, on the self cost (SVK).
  generalMarkupPercent: number;
}

export interface DirectCosts {
  /** dM — direct material. */
  materialCost: number;
  /** dL — direct labor from the routing. */
  laborCost: number;
  /** TO — manufacturing overhead, already summed per work center. */
  overhead: number;
  /** Lego — subcontracted work (service articles in the structure). */
  subcontractCost: number;
  /**
   * Halvfabrikat — manufactured sub-assemblies costed from their OWN structure
   * and routing (multi-level). Deliberately a required field rather than an
   * optional one with a default: every construction site should fail to compile
   * until it has decided what belongs here. Always 0 in a single-level run.
   */
  semiFinishedCost: number;
}

export interface MarkedUpCosts extends DirectCosts {
  materialOverhead: number;
  subcontractOverhead: number;
  /** TVK — tillverkningskostnad. Derived, never stored. */
  manufacturingCost: number;
  businessOverhead: number;
  /** SVK — självkostnad. Derived, never stored. */
  selfCost: number;
  generalMarkup: number;
  salesPrice: number;
}

function percentOf(base: number, percent: number): number {
  return base * (percent / 100);
}

export function applyMarkups(direct: DirectCosts, markups: CostingMarkups): MarkedUpCosts {
  const materialOverhead = percentOf(direct.materialCost, markups.moPercent);
  const subcontractOverhead = percentOf(direct.subcontractCost, markups.loPercent);
  // semiFinishedCost enters TVK with NO markup of its own — MO/TO/LO were
  // already applied one level down, inside the sub-assembly's own calculation.
  // Affo and the general markup below therefore hit it exactly once, at the
  // top, which is the whole point of passing the sub-level's TVK (rather than
  // its SVK) upwards.
  const manufacturingCost =
    direct.materialCost +
    materialOverhead +
    direct.laborCost +
    direct.overhead +
    direct.subcontractCost +
    subcontractOverhead +
    direct.semiFinishedCost;
  const businessOverhead = percentOf(manufacturingCost, markups.affoPercent);
  const selfCost = manufacturingCost + businessOverhead;
  const generalMarkup = percentOf(selfCost, markups.generalMarkupPercent);
  return {
    ...direct,
    materialOverhead,
    subcontractOverhead,
    manufacturingCost,
    businessOverhead,
    selfCost,
    generalMarkup,
    salesPrice: selfCost + generalMarkup,
  };
}

export interface ArticleCostBasis {
  standardCost: string | null;
  /** The primary supplier's price (article_suppliers.is_primary), if any. */
  supplierPrice: string | null;
  /**
   * The primary supplier's staffel (article_supplier_price_breaks), used only
   * when the calculation is configured for tiered supplier prices. Absent on
   * paths that never load it.
   */
  supplierPriceBreaks?: PriceBreak[];
  /**
   * Verklig kostnad: the moving average at the moment the material was
   * actually consumed, derived by the caller (actual-cost.ts) rather than
   * looked up here — this function stays pure and database-free. Null when it
   * could not be derived; absent on every path that does not ask for it.
   */
  actualCost?: number | null;
}

// The unit cost of one component, per the configured material source. Source
// "supplier" falls back to the standard cost rather than failing — a
// manufactured or newly registered component may never have a supplier — and
// every fallback is reported so the user can see which rows were estimated.
// `used` is that same information in structured form: it goes on the saved
// material row, so the specification can mark a row as estimated without
// re-parsing the warning text.
export function resolveUnitCost(
  basis: ArticleCostBasis | undefined,
  source: CostingMaterialSource,
  // Stafflade leverantörspriser (System → Kalkyler): with "tiered" the
  // supplier price is the staffel step for `quantity` (the row's total
  // quantity); "base" — the default — is the grundpris as before. `used`
  // stays "supplier" either way: the row's unitCost records the price.
  tier: { supplierPriceTier: CostingSupplierPriceTier; quantity: number } = { supplierPriceTier: "base", quantity: 1 }
): { cost: number; used: CostPriceSource; warning: string | null } {
  const standardCost = basis?.standardCost ?? null;
  const basePrice = basis?.supplierPrice ?? null;
  const supplierPrice =
    tier.supplierPriceTier === "tiered"
      ? resolveSupplierPrice(
          { price: basePrice === null ? null : Number(basePrice), priceBreaks: basis?.supplierPriceBreaks ?? [] },
          tier.quantity
        ).price
      : basePrice;

  if (source === "actual") {
    const actualCost = basis?.actualCost ?? null;
    if (actualCost !== null) return { cost: actualCost, used: "moving_average", warning: null };
    if (standardCost !== null) {
      return {
        cost: Number(standardCost),
        used: "standard",
        warning: "ingen verklig kostnad vid förbrukningen, använder standardpris",
      };
    }
    return { cost: 0, used: "none", warning: "varken verklig kostnad eller standardpris, antar 0" };
  }

  if (source === "supplier") {
    if (supplierPrice !== null) return { cost: Number(supplierPrice), used: "supplier", warning: null };
    if (standardCost !== null) {
      return { cost: Number(standardCost), used: "standard", warning: "inget leverantörspris, använder standardpris" };
    }
    return { cost: 0, used: "none", warning: "varken leverantörspris eller standardpris, antar 0" };
  }

  if (standardCost !== null) return { cost: Number(standardCost), used: "standard", warning: null };
  return { cost: 0, used: "none", warning: "saknar standardpris, antar 0" };
}

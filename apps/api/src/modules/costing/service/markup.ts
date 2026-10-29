import { SEK, toSekUnitPrice, type CostingMaterialSource, type CostingSupplierPriceTier, type CostPriceSource } from "@navet/shared";
import { resolveSupplierPrice, type PriceBreak } from "../../purchase/service/supplier-price.js";

// Monitor's påläggskalkyl, as pure arithmetic — no DB, no settings lookup, so
// the chain can be tested on its own. TO (tillverkningsomkostnad) is not a
// markup percentage here: it already sits per work center on
// work_centers.overhead_percent and arrives as `overhead`. It is also NOT part
// of TVK or SVK: it is added last, towards the sales price, after the general
// markup, and carries no profit markup of its own. The materialpåslag is the
// same kind of step — a sales markup on dM + MO, outside TVK/SVK so the self
// cost stays the real cost, and not stacked with the general markup —
//   TVK = dM + MO + dL + Lego + LO + Halvfabrikat
//   SVK = TVK + Affo
//   Försäljningspris = SVK + generellt påslag + materialpåslag + TO
export interface CostingMarkups {
  // MO = materialomkostnader, on direct material.
  moPercent: number;
  // LO = legoomkostnader, on subcontracted work.
  loPercent: number;
  // Affo = affärsomkostnader, on the manufacturing cost (TVK).
  affoPercent: number;
  // Vinstpålägg, on the self cost (SVK).
  generalMarkupPercent: number;
  // Materialpåslag, on dM + MO — sales price only.
  materialMarkupPercent: number;
}

export interface DirectCosts {
  /** dM — direct material. */
  materialCost: number;
  /** dL — direct labor from the routing. */
  laborCost: number;
  /**
   * TO — manufacturing overhead, already summed per work center (and, in a
   * multi-level run, the sub-assemblies' TO lifted up to this level). Outside
   * TVK/SVK: added to the sales price only.
   */
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
  /**
   * Materialpåslag the sub-assemblies (semi rows) lifted up to this level —
   * their own dM + MO's markup, recursively. Outside TVK/SVK like TO, so it
   * cannot travel inside semiFinishedCost. Always 0 in a single-level run.
   */
  liftedMaterialMarkup: number;
}

export interface MarkedUpCosts extends DirectCosts {
  materialOverhead: number;
  subcontractOverhead: number;
  /** TVK — tillverkningskostnad, without TO. Derived, never stored. */
  manufacturingCost: number;
  businessOverhead: number;
  /** SVK — självkostnad, without TO. Derived, never stored. */
  selfCost: number;
  generalMarkup: number;
  /** Materialpåslag on dM + MO, plus what the sub-assemblies lifted up. */
  materialMarkup: number;
  /** SVK + generellt påslag + materialpåslag + TO. */
  salesPrice: number;
}

function percentOf(base: number, percent: number): number {
  return base * (percent / 100);
}

export function applyMarkups(direct: DirectCosts, markups: CostingMarkups): MarkedUpCosts {
  const materialOverhead = percentOf(direct.materialCost, markups.moPercent);
  const subcontractOverhead = percentOf(direct.subcontractCost, markups.loPercent);
  // semiFinishedCost enters TVK with NO markup of its own — MO/LO were already
  // applied one level down, inside the sub-assembly's own calculation. Affo
  // and the general markup below therefore hit it exactly once, at the top,
  // which is the whole point of passing the sub-level's TVK (rather than its
  // SVK) upwards. TO is deliberately absent from TVK: it is added to the sales
  // price below, after the general markup, so neither Affo nor the general
  // markup is ever charged on it.
  const manufacturingCost =
    direct.materialCost +
    materialOverhead +
    direct.laborCost +
    direct.subcontractCost +
    subcontractOverhead +
    direct.semiFinishedCost;
  const businessOverhead = percentOf(manufacturingCost, markups.affoPercent);
  const selfCost = manufacturingCost + businessOverhead;
  const generalMarkup = percentOf(selfCost, markups.generalMarkupPercent);
  // On dM + MO only — never on a semi row's TVK (its material got its markup
  // one level down and arrives as liftedMaterialMarkup) and never on labor.
  const materialMarkup =
    percentOf(direct.materialCost + materialOverhead, markups.materialMarkupPercent) + direct.liftedMaterialMarkup;
  return {
    ...direct,
    materialOverhead,
    subcontractOverhead,
    manufacturingCost,
    businessOverhead,
    selfCost,
    generalMarkup,
    materialMarkup,
    salesPrice: selfCost + generalMarkup + materialMarkup + direct.overhead,
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
   * The primary supplier's currency (article_suppliers.currency) — the
   * supplier price and its staffel are in it. Absent or SEK = no conversion.
   */
  supplierCurrency?: string | null;
  /**
   * SEK per 1 unit of supplierCurrency, looked up by the caller for today
   * (getRate may call Riksbanken, so this function cannot). Null = no rate
   * for the currency: the supplier price is then treated as missing rather
   * than read as kronor. Ignored for SEK.
   */
  supplierExchangeRate?: number | null;
  /**
   * Verklig kostnad: the moving average at the moment the material was
   * actually consumed, derived by the caller (actual-cost.ts) rather than
   * looked up here — this function stays pure and database-free. Null when it
   * could not be derived; absent on every path that does not ask for it.
   */
  actualCost?: number | null;
}

// A supplier price costed from another currency: the price as the catalog
// states it and the rate it was converted at. Goes on the saved material row
// so the specification can show what the kronor figure came from.
export interface ForeignSupplierPrice {
  currency: string;
  unitPrice: number;
  rate: number;
}

// The unit cost of one component, per the configured material source. Source
// "supplier" falls back to the standard cost rather than failing — a
// manufactured or newly registered component may never have a supplier — and
// every fallback is reported so the user can see which rows were estimated.
// `used` is that same information in structured form: it goes on the saved
// material row, so the specification can mark a row as estimated without
// re-parsing the warning text.
//
// A supplier price in another currency is converted to SEK at
// supplierExchangeRate (to four decimals, toSekUnitPrice) and reported in
// `foreign`. Without a rate it falls back exactly like a missing supplier
// price — reading 10 EUR as 10 kr would understate the cost with no sign of
// it — and the warning names the currency.
export function resolveUnitCost(
  basis: ArticleCostBasis | undefined,
  source: CostingMaterialSource,
  // Stafflade leverantörspriser (System → Kalkyler): with "tiered" the
  // supplier price is the staffel step for `quantity` (the row's total
  // quantity); "base" — the default — is the grundpris as before. `used`
  // stays "supplier" either way: the row's unitCost records the price.
  tier: { supplierPriceTier: CostingSupplierPriceTier; quantity: number } = { supplierPriceTier: "base", quantity: 1 }
): { cost: number; used: CostPriceSource; warning: string | null; foreign?: ForeignSupplierPrice } {
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
    const currency = basis?.supplierCurrency ?? SEK;
    const rate = basis?.supplierExchangeRate ?? null;
    if (supplierPrice !== null && currency === SEK) return { cost: Number(supplierPrice), used: "supplier", warning: null };
    if (supplierPrice !== null && rate !== null) {
      const unitPrice = Number(supplierPrice);
      return {
        cost: toSekUnitPrice(unitPrice, rate),
        used: "supplier",
        warning: null,
        foreign: { currency, unitPrice, rate },
      };
    }
    // Either no supplier price at all, or one in a currency without a rate.
    const missing = supplierPrice === null ? "inget leverantörspris" : `ingen kurs för leverantörspriset i ${currency}`;
    if (standardCost !== null) {
      return { cost: Number(standardCost), used: "standard", warning: `${missing}, använder standardpris` };
    }
    return {
      cost: 0,
      used: "none",
      warning:
        supplierPrice === null ? "varken leverantörspris eller standardpris, antar 0" : `${missing} och inget standardpris, antar 0`,
    };
  }

  if (standardCost !== null) return { cost: Number(standardCost), used: "standard", warning: null };
  return { cost: 0, used: "none", warning: "saknar standardpris, antar 0" };
}

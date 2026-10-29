import { z } from "zod";

export const costCalculationTypeSchema = z.enum(["pre", "post"]);
export type CostCalculationType = z.infer<typeof costCalculationTypeSchema>;

// Where a component's unit cost is read from when calculating direct material.
// "supplier" = the article's primary supplier price (article_suppliers.is_primary),
// falling back to the article's standard cost; "standard" = standard cost only;
// "actual" = the moving average at the consumption date, derived from the stock
// log. "actual" applies to the POST-calculation only — a pre-calculation has no
// consumptions to price — so the two calculations have one setting each
// (System → Kalkyler) and the förkalkyl's cannot be "actual".
export const costingMaterialSourceSchema = z.enum(["supplier", "standard", "actual"]);
export type CostingMaterialSource = z.infer<typeof costingMaterialSourceSchema>;
export const costingPreMaterialSourceSchema = z.enum(["supplier", "standard"]);
export type CostingPreMaterialSource = z.infer<typeof costingPreMaterialSourceSchema>;

// Only meaningful with source "supplier": "base" = the catalog row's
// grundpris (quantity 1) regardless of quantity; "tiered" = the staffel step
// for the component's total quantity in the calculation.
export const costingSupplierPriceTierSchema = z.enum(["base", "tiered"]);
export type CostingSupplierPriceTier = z.infer<typeof costingSupplierPriceTierSchema>;

// Which price a material row actually used. Differs from the calculation's
// configured source when "supplier"/"actual" fell back to the standard cost.
// "calculated" = a sub-assembly costed from its own structure and routing
// (multi-level); "moving_average" = the derived actual cost at consumption.
export const costPriceSourceSchema = z.enum(["supplier", "standard", "none", "calculated", "moving_average"]);
export type CostPriceSource = z.infer<typeof costPriceSourceSchema>;

// Service articles in the structure are lego and carry LO; the rest is direct
// material and carries MO. "semi" = a manufactured sub-assembly costed from its
// own structure and routing — it carries NO markup of its own, because its
// calculated manufacturing cost already contains them.
export const costMaterialRowKindSchema = z.enum(["material", "subcontract", "semi"]);
export type CostMaterialRowKind = z.infer<typeof costMaterialRowKindSchema>;

// `save` absent or false = preview: the numbers are computed and returned but
// nothing is written. Only an explicit `true` stores the calculation.
export const preCalculateSchema = z.object({
  quantity: z.coerce.number().positive(),
  save: z.boolean().optional(),
  // Räkna om underliggande nivåer: cost manufactured sub-assemblies from their
  // own structure and routing instead of from their standard cost. Plain
  // z.boolean(), never z.coerce.boolean() — the latter turns the string
  // "false" into true, which has bitten this codebase before.
  multiLevel: z.boolean().optional(),
});
export type PreCalculateInput = z.infer<typeof preCalculateSchema>;

// The post-calculation takes no other input, and the request may carry no body
// at all (apiFetch omits it for body-less action calls), so the route parses
// `req.body ?? {}` against this.
export const postCalculateSchema = z.object({
  save: z.boolean().optional(),
});
export type PostCalculateInput = z.infer<typeof postCalculateSchema>;

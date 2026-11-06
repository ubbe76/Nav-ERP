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

// Avvikelseanalys i efterkalkylen (#14) — the `analysis` field on
// POST …/post-calculate (preview and save) and GET /cost-calculations/:id.
// null on a förkalkyl and on an efterkalkyl saved before the analysis. The
// server computes everything (cost-variance.ts); the web only shows it, so
// there is no mirror. Amounts are kronor rounded to öre, quantities are in
// the component's base unit, hours are hours.
//
// Kalkylerat (`base`) = the order's own rows for the produced quantity N,
// material priced with the förkalkyl's rules as of T₀ (the order's
// created_at); Utfall (`actual`) = the efterkalkyl's rows. On every row and
// on the order: actual − base = deviation = the sum of the parts (`scrap` is
// "varav" of `quantity` and NOT added). The order's markups (MO + LO, the
// efterkalkyl's percentages on both sides) are one part of their own; TO is
// outside TVK and not in the analysis.
export interface CostVarianceParts {
  // Pris: material/lego à-pris, ställ-/transportpris and rate on lego.
  price: number;
  // Mängd: material/lego quantity, scrap included.
  quantity: number;
  // Varav kassation — the part of `quantity` the scrapped units drew. Not summed.
  scrap: number;
  // Timpris: (R − R₀) × H. 0 until the hourly rate has a history (etapp 4).
  rate: number;
  // Ställ and Stycke: time deviation on an operation whose time is fully
  // split into ställ/produktion (in etapp 1 only an operation without time).
  setup: number;
  run: number;
  // Tid (ej uppdelad): the time deviation of an operation with time that is
  // not split into ställ/produktion (all reported time before etapp 3).
  unclassified: number;
  // Påslag (följer av material och lego): MO + LO, on the order only (0 on rows).
  markups: number;
}

export interface CostVarianceMaterialRow {
  // The saved cost_calculation_material_rows id; null in a preview.
  id: string | null;
  componentArticleId: string;
  articleNumber: string;
  articleName: string;
  // "subcontract" = a service article (shown under Lego).
  kind: CostMaterialRowKind;
  // Kalkylerat antal (SQ) and à-pris (SP), and the price source SP came from;
  // all null on a row without a base (counted as 0, the whole row is Mängd).
  baseQuantity: number | null;
  baseUnitCost: number | null;
  basePriceSource: CostPriceSource | null;
  // Antal (AQ, consumed net) and À-pris (AP) as on the efterkalkyl's row.
  quantity: number;
  unitCost: number;
  // The planned share of the scrapped units — what "varav kassation" prices.
  scrapQuantity: number;
  base: number;
  actual: number;
  deviation: number;
  parts: CostVarianceParts;
}

export interface CostVarianceTimeOperationRow {
  kind: "time";
  // The saved cost_calculation_operation_rows id; null in a preview.
  id: string | null;
  sequenceNo: number;
  workCenterId: string;
  workCenterCode: string;
  workCenterName: string;
  // Planerad ställ (Bs — 0 while the setup does not count yet) and Planerad
  // stycke (Br = run time × N); null on a row without a base.
  baseSetupHours: number | null;
  baseRunHours: number | null;
  baseHourlyRate: number | null;
  // H = all reported hours; Verklig ställ / Verklig stycke (null until the
  // time is registered as ställ/produktion, etapp 3) and Ej uppdelad (h).
  hours: number;
  setupHours: number | null;
  runHours: number | null;
  unclassifiedHours: number;
  hourlyRate: number;
  // true ⇒ the time deviation is in parts.setup/run; false ⇒ in
  // parts.unclassified (some reported time is not split).
  split: boolean;
  base: number;
  actual: number;
  deviation: number;
  parts: CostVarianceParts;
}

export interface CostVarianceSubcontractOperationRow {
  kind: "subcontract";
  id: string | null;
  sequenceNo: number;
  workCenterId: string;
  workCenterCode: string;
  workCenterName: string;
  // N for the operation, P₀ and F₀ (0 while the one-off does not count yet);
  // null on a row without a base.
  baseQuantity: number | null;
  baseUnitPrice: number | null;
  baseOneOff: number | null;
  // Qa: what the cost was taken for (Σ received on the IO rows, else OK).
  subcontractQuantity: number | null;
  base: number;
  actual: number;
  deviation: number;
  parts: CostVarianceParts;
}

export type CostVarianceOperationRow = CostVarianceTimeOperationRow | CostVarianceSubcontractOperationRow;

export interface CostVarianceAnalysis {
  // N: the order's received quantity (Inlevererat).
  outputQuantity: number;
  // The order was not Klar/Stängd/Makulerad: each operation (its time, its lego and its
  // linked material) is based on the operation's OK quantity and unlinked
  // material on the received quantity, so work in progress is not a
  // deviation. Kalkylutfall leaves preliminary analyses out of its sums.
  preliminary: boolean;
  // T₀ (ISO) and the förkalkyl's material source the base was priced with.
  basePricedAt: string;
  baseMaterialSource: CostingPreMaterialSource;
  // Kalkylerat, Utfall, Avvikelse for the order (TVK without TO). Utfall is
  // exactly the efterkalkyl's TVK; the rows' rounding rest is in parts.markups.
  base: number;
  actual: number;
  deviation: number;
  parts: CostVarianceParts;
  materialRows: CostVarianceMaterialRow[];
  operationRows: CostVarianceOperationRow[];
}

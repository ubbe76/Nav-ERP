import { z } from "zod";
import { listQuerySchema } from "./list.js";
import { parcelKindSchema } from "./shipping.js";
// vatRates/vatRateSchema moved to vat.ts in B5 — imported here for the
// varugrupp schemas below, re-exported to consumers via index.ts.
import { vatRateSchema } from "./vat.js";
import { optionalText } from "./coerce.js";

// Avrundning — a positive step with at most 3 decimals (numeric(14,3) in the
// database). The decimal check is on the scaled integer so float noise never
// rejects a legitimate 0.3.
const roundingSchema = z.coerce
  .number()
  .positive()
  .refine((v) => Math.abs(v * 1000 - Math.round(v * 1000)) < 1e-6, "Avrundning får ha högst 3 decimaler");

export const articleTypeSchema = z.enum(["manufactured", "purchased", "service"]);
export type ArticleType = z.infer<typeof articleTypeSchema>;

export const listArticlesQuerySchema = listQuerySchema.extend({
  type: articleTypeSchema.optional(),
  groupId: z.string().uuid().optional(),
  // Artikelkod (Grunddata) — the list's selection besides the varugrupp.
  articleCodeId: z.string().uuid().optional(),
  // Only articles that can be put on an order row: excludes a template (mall)
  // in configurator mode `variants` — its variants are what gets ordered.
  // Omitted ⇒ the list is unchanged.
  orderable: z.enum(["true", "false"]).transform((v) => v === "true").optional(),
  // With orderable=true: templates in mode variants are listed again (the order
  // forms' Konfigurera entry point); they carry configuratorMode as always.
  // Without orderable it has no effect.
  configurable: z.enum(["true", "false"]).transform((v) => v === "true").optional(),
});
export type ListArticlesQuery = z.infer<typeof listArticlesQuerySchema>;

// "Kopiera från befintlig artikel": the parts of a source article a new
// article can be created from. Beredning (BOM + routing) only goes to a
// manufactured article and Inköp (supplier catalog) only to a purchased or
// service article — enforced in the article service, mirrored in the web's
// copy dialog (apps/web/lib/articleCopy.ts).
export const articleCopyParts = ["information", "beredning", "inkop", "filer"] as const;
export const articleCopyPartSchema = z.enum(articleCopyParts);
export type ArticleCopyPart = z.infer<typeof articleCopyPartSchema>;
export const ARTICLE_COPY_PART_TYPES: Partial<Record<ArticleCopyPart, readonly ArticleType[]>> = {
  beredning: ["manufactured"],
  inkop: ["purchased", "service"],
};
export function articleCopyPartAllowed(part: ArticleCopyPart, type: ArticleType): boolean {
  const allowed = ARTICLE_COPY_PART_TYPES[part];
  return allowed === undefined || allowed.includes(type);
}
export const articleCopyFromSchema = z.object({
  articleId: z.string().uuid(),
  parts: z
    .array(articleCopyPartSchema)
    .min(1)
    .refine((parts) => new Set(parts).size === parts.length, "Each part may only be given once"),
});
export type ArticleCopyFromInput = z.infer<typeof articleCopyFromSchema>;

export const createArticleSchema = z.object({
  // Omitted ⇒ the next free number in an article number series: the one
  // given (numberSeriesKey), else the group's, else the default "article".
  articleNumber: z.string().min(1).max(50).optional(),
  numberSeriesKey: z.string().min(1).max(50).optional(),
  name: z.string().min(1).max(255),
  type: articleTypeSchema,
  // Phantom BOM article (Monitor-style fantomartikel) — locked after creation, like `type`.
  isPhantom: z.boolean().default(false),
  // Base unit (grundenhet) from the units register; omitted = the "st" unit
  // (created on first use). Default purchase/sales units must be the base
  // unit or one of the article's alternative units; null = base unit.
  unitId: z.string().uuid().optional(),
  purchaseUnitId: z.string().uuid().nullable().optional(),
  salesUnitId: z.string().uuid().nullable().optional(),
  standardCost: z.coerce.number().nonnegative().optional(),
  salesPrice: z.coerce.number().nonnegative().optional(),
  // No VAT rate of its own since 0155: the varugrupp's (groupId) applies.
  // Nettovikt (kg) and dimensions (mm) — used later for volume/transport.
  weight: z.coerce.number().nonnegative().optional(),
  length: z.coerce.number().nonnegative().optional(),
  width: z.coerce.number().nonnegative().optional(),
  height: z.coerce.number().nonnegative().optional(),
  // Standard packaging: base units per kolli + the kolli type (register).
  quantityPerPackage: z.coerce.number().nonnegative().optional(),
  packageTypeId: z.string().uuid().optional(),
  // Frakt, egna mått: kolliart (omitted = Paket), stapelbar, pallplatser and
  // flakmeter (derived from pallplatser when omitted — deriveLoadingMeters).
  parcelKind: parcelKindSchema.optional(),
  stackable: z.boolean().optional(),
  palletSpaces: z.coerce.number().nonnegative().optional(),
  loadingMeters: z.coerce.number().nonnegative().optional(),
  // Planning (E1 behovsberäkning): beställningspunkt + orderkvantitet, plus
  // Avrundning — the step proposals AND order-row quantities are rounded up
  // to (roundUpToMultiple in units.ts). Positive, at most 3 decimals.
  reorderPoint: z.coerce.number().nonnegative().optional(),
  orderQuantity: z.coerce.number().positive().optional(),
  rounding: roundingSchema.optional(),
  // "Ytbehandling" / "Färg" — free text printed on documents (see the
  // articles schema); blank = not filled in.
  surfaceTreatment: optionalText(200).optional(),
  colour: optionalText(200).optional(),
  // "Extra benämning" — multi-line free text, printed on the documents the
  // setting extraDescriptionDocuments lists; blank = none.
  extraDescription: optionalText(2000).optional(),
  groupId: z.string().uuid().optional(),
  // Artikelkod (Grunddata): selection/grouping in the lists only.
  articleCodeId: z.string().uuid().optional(),
  // Default stock location; omitted = the auto-created "***" location.
  defaultLocationId: z.string().uuid().optional(),
  active: z.boolean().default(true),
  // Copy the chosen parts of an existing article into the new one, in the
  // same transaction as the create. Fields sent in this request always win
  // over the source's; articleNumber/name never come from the source. The
  // new-article form's own fields (type, isPhantom, unitId, standardCost,
  // groupId, defaultLocationId) are NEVER taken from the source either —
  // the client pre-fills them from it (isPhantom's zod default makes "not
  // sent" indistinguishable from false).
  copyFrom: articleCopyFromSchema.optional(),
});
export type CreateArticleInput = z.infer<typeof createArticleSchema>;

export const updateStandardCostSchema = z.object({
  standardCost: z.coerce.number().nonnegative(),
});
export type UpdateStandardCostInput = z.infer<typeof updateStandardCostSchema>;

// Everything on the article is editable, including articleNumber (unique —
// duplicates come back as 409), type and isPhantom. groupId/articleCodeId
// are nullable to allow clearing them.
export const updateArticleSchema = z
  .object({
    articleNumber: z.string().min(1).max(50).optional(),
    name: z.string().min(1).max(255).optional(),
    type: articleTypeSchema.optional(),
    isPhantom: z.boolean().optional(),
    // Blocked (409) while the article has alternative units — changing the
    // base unit would silently change what the factors mean.
    unitId: z.string().uuid().optional(),
    purchaseUnitId: z.string().uuid().nullable().optional(),
    salesUnitId: z.string().uuid().nullable().optional(),
    active: z.boolean().optional(),
    salesPrice: z.coerce.number().nonnegative().nullable().optional(),
    // The varugrupp also sets the article's VAT rate (no rate of its own).
    groupId: z.string().uuid().nullable().optional(),
    articleCodeId: z.string().uuid().nullable().optional(),
    // Null resets to the "***" fallback behavior.
    defaultLocationId: z.string().uuid().nullable().optional(),
    // Nettovikt (kg) and dimensions (mm); null clears the value.
    weight: z.coerce.number().nonnegative().nullable().optional(),
    length: z.coerce.number().nonnegative().nullable().optional(),
    width: z.coerce.number().nonnegative().nullable().optional(),
    height: z.coerce.number().nonnegative().nullable().optional(),
    // Standard packaging (null clears).
    quantityPerPackage: z.coerce.number().nonnegative().nullable().optional(),
    packageTypeId: z.string().uuid().nullable().optional(),
    // Frakt, egna mått (null clears).
    parcelKind: parcelKindSchema.nullable().optional(),
    stackable: z.boolean().optional(),
    palletSpaces: z.coerce.number().nonnegative().nullable().optional(),
    loadingMeters: z.coerce.number().nonnegative().nullable().optional(),
    // Planning (E1 behovsberäkning); null clears.
    reorderPoint: z.coerce.number().nonnegative().nullable().optional(),
    orderQuantity: z.coerce.number().positive().nullable().optional(),
    rounding: roundingSchema.nullable().optional(),
    // "Ytbehandling" / "Färg" — free text printed on documents; "" clears.
    surfaceTreatment: optionalText(200).optional(),
    colour: optionalText(200).optional(),
    // "Extra benämning"; "" clears.
    extraDescription: optionalText(2000).optional(),
  })
  .refine((data) => Object.keys(data).length > 0, "At least one field must be provided");
export type UpdateArticleInput = z.infer<typeof updateArticleSchema>;

// Inline editing in the article register: Benämning, Typ, Grupp and
// Standardenhet only, 1–500 rows per request. Field validators are the ones
// updateArticleSchema uses; each row is strict and needs at least one field.
const updateArticleFields = updateArticleSchema.innerType().shape;
export const batchUpdateArticleRowSchema = z
  .object({
    id: z.string().uuid(),
    name: updateArticleFields.name,
    type: updateArticleFields.type,
    groupId: updateArticleFields.groupId,
    unitId: updateArticleFields.unitId,
  })
  .strict()
  .refine((row) => Object.keys(row).length > 1, "At least one field besides id must be provided");
export const batchUpdateArticlesSchema = z.object({ rows: z.array(batchUpdateArticleRowSchema).min(1).max(500) });
export type BatchUpdateArticleRow = z.infer<typeof batchUpdateArticleRowSchema>;
export type BatchUpdateArticlesInput = z.infer<typeof batchUpdateArticlesSchema>;

// BOM = Bill of Materials / struktur — komponentrad kopplad till en parent-artikel
export const createBomComponentSchema = z.object({
  componentArticleId: z.string().uuid(),
  quantity: z.coerce.number().positive(),
  // Unit the quantity is entered in — the component's base unit (null/omitted)
  // or one of its alternative units. Stored quantity is always in the base
  // unit; the factor is snapshotted on the row for display.
  unitId: z.string().uuid().nullable().optional(),
  // Optional link to one of the parent article's routing operations — the
  // component is drawn from stock when that operation is reported complete.
  routingOperationId: z.string().uuid().nullable().optional(),
  // "Pos." — the position on the drawing; blank = none.
  position: optionalText(20).optional(),
});
export type CreateBomComponentInput = z.infer<typeof createBomComponentSchema>;

// Quantity and the operation link are editable on a BOM row — swapping the
// component itself is remove + add, which keeps cycle validation in one place.
export const updateBomComponentSchema = z
  .object({
    // Interpreted in the row's unit (or the newly provided unitId).
    quantity: z.coerce.number().positive().optional(),
    // Null switches the row back to the component's base unit.
    unitId: z.string().uuid().nullable().optional(),
    routingOperationId: z.string().uuid().nullable().optional(),
    // "Pos."; "" clears.
    position: optionalText(20).optional(),
  })
  .refine((data) => Object.keys(data).length > 0, "At least one field must be provided");
export type UpdateBomComponentInput = z.infer<typeof updateBomComponentSchema>;

// Varugrupper (artikelgrupper in the code, Monitor-style): kontering, momssats, statistik/rapportuppdelning.
export const articleGroupCodeSchema = z.string().regex(/^\d{1,4}$/, "Koden ska vara 1–4 siffror");

export const createArticleGroupSchema = z.object({
  code: articleGroupCodeSchema,
  name: z.string().min(1).max(100),
  description: optionalText(500).optional(),
  // The article number series new articles in the group draw from; null =
  // the default series.
  numberSeriesKey: z.string().min(1).max(50).nullable().optional(),
  // Kostnadsställe (förval) for invoice/supplier invoice rows in the group.
  defaultCostCenterId: z.string().uuid().nullable().optional(),
  // Momssats: the rate of every article in the group; omitted = 25 %.
  vatRate: vatRateSchema.optional(),
});
export type CreateArticleGroupInput = z.infer<typeof createArticleGroupSchema>;

export const updateArticleGroupSchema = z.object({
  code: articleGroupCodeSchema,
  name: z.string().min(1).max(100),
  description: optionalText(500).optional(),
  numberSeriesKey: z.string().min(1).max(50).nullable().optional(),
  defaultCostCenterId: z.string().uuid().nullable().optional(),
  // Omitted = unchanged.
  vatRate: vatRateSchema.optional(),
});
export type UpdateArticleGroupInput = z.infer<typeof updateArticleGroupSchema>;

// Artikelrevisioner & ritningar (drawing numbers with their own revisions) —
// pure metadata registers on the article, at most one active revision each.
export const createArticleRevisionSchema = z.object({
  revision: z.string().min(1).max(20),
  comment: z.string().optional(),
  isActive: z.boolean().default(false),
});
export type CreateArticleRevisionInput = z.infer<typeof createArticleRevisionSchema>;

export const updateArticleRevisionSchema = z
  .object({
    revision: z.string().min(1).max(20).optional(),
    comment: z.string().nullable().optional(),
    isActive: z.boolean().optional(),
  })
  .refine((data) => Object.keys(data).length > 0, "At least one field must be provided");
export type UpdateArticleRevisionInput = z.infer<typeof updateArticleRevisionSchema>;

export const createArticleDrawingSchema = z.object({
  drawingNumber: z.string().min(1).max(50),
});
export type CreateArticleDrawingInput = z.infer<typeof createArticleDrawingSchema>;

export const updateArticleDrawingSchema = z.object({
  drawingNumber: z.string().min(1).max(50),
});
export type UpdateArticleDrawingInput = z.infer<typeof updateArticleDrawingSchema>;

// Drawing revisions share the article revision's shape.
export const createDrawingRevisionSchema = createArticleRevisionSchema;
export type CreateDrawingRevisionInput = z.infer<typeof createDrawingRevisionSchema>;
export const updateDrawingRevisionSchema = updateArticleRevisionSchema;
export type UpdateDrawingRevisionInput = z.infer<typeof updateDrawingRevisionSchema>;

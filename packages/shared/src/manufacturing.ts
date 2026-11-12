import { z } from "zod";
import { blankSafe, INT4_MAX, numericMax, optionalText } from "./coerce.js";
import { configuratorSelectionSchema } from "./configurator.js";
import { listQuerySchema, manufacturingOrderStatusListParam, statusListParam } from "./list.js";

export const manufacturingOrderStatusSchema = z.enum([
  "planned",
  "released",
  "in_progress",
  "done",
  "closed",
  "cancelled",
]);
export type ManufacturingOrderStatus = z.infer<typeof manufacturingOrderStatusSchema>;

export const listManufacturingOrdersQuerySchema = listQuerySchema.extend({
  // Also "late" (Sen) and "component_late" (Halvfabrikat sent, pegging #9)
  // — see manufacturingOrderStatusListParam in list.ts.
  status: manufacturingOrderStatusListParam(manufacturingOrderStatusSchema.options),
  // Adds an `operations` summary (sequence, status, work center, production
  // group) to each row, e.g. for integrations. An extra batched query, so
  // it's opt-in. Same "true"/"false" string pattern as withOpenRows in sales.ts.
  // Sort on order number: newest first by default; "asc" lets Översikten take
  // the oldest active orders (limit=6) the way it always listed them.
  order: z.enum(["asc", "desc"]).optional(),
  withOperations: z
    .enum(["true", "false"])
    .transform((value) => value === "true")
    .optional(),
});
export type ListManufacturingOrdersQuery = z.infer<typeof listManufacturingOrdersQuerySchema>;

// Terminalens operationslista: comma-separated station ids, optional material.
export const terminalOperationsQuerySchema = z.object({
  workCenterIds: z
    .string()
    .optional()
    .transform((v) => (v ? v.split(",").filter(Boolean) : undefined))
    .pipe(z.array(z.string().uuid()).optional()),
  materialArticleId: z.string().uuid().optional(),
});
export type TerminalOperationsQuery = z.infer<typeof terminalOperationsQuerySchema>;

// Resource number (resursnummer): exactly 3 digits, freely chosen — carries
// no grouping meaning; resources are grouped via production groups instead.
export const workCenterCodeSchema = z.string().regex(/^\d{3}$/, "Numret ska vara exakt 3 siffror");

// Resurstyp — machine, person, or a legoresurs (subcontractor). Subcontract
// resources share the code series with the others but have no production
// group/hourly rate/schedule; instead they carry a default supplier.
export const workCenterTypes = ["machine", "personnel", "subcontract"] as const;
export type WorkCenterType = (typeof workCenterTypes)[number];

export const createWorkCenterSchema = z.object({
  code: workCenterCodeSchema,
  name: z.string().min(1).max(100),
  type: z.enum(workCenterTypes).default("machine"),
  productionGroupId: z.string().uuid().nullable().optional(),
  hourlyRate: blankSafe(z.coerce.number().nonnegative().max(numericMax(10, 2))).default(0),
  overheadPercent: blankSafe(z.coerce.number().nonnegative().max(numericMax(5, 2))).default(0),
  // E2 capacity: available time = the week schedule's resolved net hours for
  // the actual week × capacityFactor (e.g. 2 = two machines/people). No
  // schedule = no capacity shown in beläggningen. Factor 0 is rejected —
  // clear the schedule instead.
  weekScheduleId: z.string().uuid().nullable().optional(),
  capacityFactor: blankSafe(z.coerce.number().positive().max(numericMax(6, 2))).default(1),
  // Kapacitet (timmar per dag): Monday–Friday hours used when the resource
  // has no week schedule (the schedule wins when both are set).
  hoursPerDay: blankSafe(z.coerce.number().positive().max(24)).nullable().optional(),
  // Legoresurs only: the resource's default supplier, prefilled on new lego
  // operations in the beredning.
  supplierId: z.string().uuid().nullable().optional(),
  active: z.boolean().default(true),
  // Monitor G5 resource defaults (imported, editable, not yet consumed by
  // the beredning). All optional/nullable — see work_centers' comment.
  defaultSetupTime: blankSafe(z.coerce.number().nonnegative().max(numericMax(10, 2))).nullable().optional(),
  defaultOperationName: z.string().max(100).nullable().optional(),
  rateAppliesToSetup: z.boolean().nullable().optional(),
  rateAppliesToRun: z.boolean().nullable().optional(),
  calcRate1: blankSafe(z.coerce.number().nonnegative().max(numericMax(10, 2))).nullable().optional(),
  calcRate2: blankSafe(z.coerce.number().nonnegative().max(numericMax(10, 2))).nullable().optional(),
  // Legoresurs only (days).
  leadTimeDays: blankSafe(z.coerce.number().nonnegative().max(numericMax(6, 1))).nullable().optional(),
  queueTimeDays: blankSafe(z.coerce.number().nonnegative().max(numericMax(6, 1))).nullable().optional(),
  orderLeadTimeDays: blankSafe(z.coerce.number().nonnegative().max(numericMax(6, 1))).nullable().optional(),
});
export type CreateWorkCenterInput = z.infer<typeof createWorkCenterSchema>;

export const updateWorkCenterSchema = z
  .object({
    code: workCenterCodeSchema.optional(),
    name: z.string().min(1).max(100).optional(),
    type: z.enum(workCenterTypes).optional(),
    productionGroupId: z.string().uuid().nullable().optional(),
    hourlyRate: blankSafe(z.coerce.number().nonnegative().max(numericMax(10, 2))).optional(),
    overheadPercent: blankSafe(z.coerce.number().nonnegative().max(numericMax(5, 2))).optional(),
    weekScheduleId: z.string().uuid().nullable().optional(),
    capacityFactor: blankSafe(z.coerce.number().positive().max(numericMax(6, 2))).optional(),
    hoursPerDay: blankSafe(z.coerce.number().positive().max(24)).nullable().optional(),
    supplierId: z.string().uuid().nullable().optional(),
    active: z.boolean().optional(),
    defaultSetupTime: blankSafe(z.coerce.number().nonnegative().max(numericMax(10, 2))).nullable().optional(),
    defaultOperationName: z.string().max(100).nullable().optional(),
    rateAppliesToSetup: z.boolean().nullable().optional(),
    rateAppliesToRun: z.boolean().nullable().optional(),
    calcRate1: blankSafe(z.coerce.number().nonnegative().max(numericMax(10, 2))).nullable().optional(),
    calcRate2: blankSafe(z.coerce.number().nonnegative().max(numericMax(10, 2))).nullable().optional(),
    leadTimeDays: blankSafe(z.coerce.number().nonnegative().max(numericMax(6, 1))).nullable().optional(),
    queueTimeDays: blankSafe(z.coerce.number().nonnegative().max(numericMax(6, 1))).nullable().optional(),
    orderLeadTimeDays: blankSafe(z.coerce.number().nonnegative().max(numericMax(6, 1))).nullable().optional(),
  })
  .refine((data) => Object.keys(data).length > 0, "At least one field must be provided");
export type UpdateWorkCenterInput = z.infer<typeof updateWorkCenterSchema>;

// GET /work-centers?type= — "subcontract" for the legoresurs register,
// "machine,personnel" for the ordinary resource register and every resource
// picker that is not about lego. Omitted = all (backwards compatible).
export const listWorkCentersQuerySchema = z.object({
  type: statusListParam(workCenterTypes),
});
export type ListWorkCentersQuery = z.infer<typeof listWorkCentersQuerySchema>;

// Produktionsgrupper — groups of resources (one group per resource).
export const createProductionGroupSchema = z.object({
  code: z.string().min(1).max(20),
  name: z.string().min(1).max(100),
  description: z.string().max(2000).optional(),
  active: z.boolean().default(true),
});
export type CreateProductionGroupInput = z.infer<typeof createProductionGroupSchema>;

export const updateProductionGroupSchema = z
  .object({
    code: z.string().min(1).max(20).optional(),
    name: z.string().min(1).max(100).optional(),
    description: z.string().max(2000).nullable().optional(),
    active: z.boolean().optional(),
  })
  .refine((data) => Object.keys(data).length > 0, "At least one field must be provided");
export type UpdateProductionGroupInput = z.infer<typeof updateProductionGroupSchema>;

// Replace-the-set semantics: checking a resource moves it into the group,
// unchecking sets its group to null.
export const setProductionGroupWorkCentersSchema = z.object({
  workCenterIds: z.array(z.string().uuid()),
});
export type SetProductionGroupWorkCentersInput = z.infer<typeof setProductionGroupWorkCentersSchema>;

// Optional text on a routing operation — the shared blank→null rule.
const optionalRoutingText = optionalText;

// "Kommentar" — free text the beredare writes on the row (Monitor G5 heads
// the column "Instruktion" in its Operationslista).
const routingCommentSchema = optionalRoutingText(1000);

// "Packinstruktion" — free text on how the articles are packed ahead of the
// next operation/shipment. Unlike the comment, it is shop-floor information
// and always prints on the work card, independent of printOnWorkCard.
const routingPackingInstructionsSchema = optionalRoutingText(1000);

// "Beskrivning" — what the step IS (Monitor's "Operationens benämning").
// Shorter ceiling than the comment: it is a heading that has to fit a table
// cell, not a note.
const routingDescriptionSchema = optionalRoutingText(255);

// Display preference for runTimePerUnit — always stored/returned in minutes
// per unit regardless of this value; see operationTimeUnitEnum in
// packages/db/src/schema/manufacturing.ts.
export const operationTimeUnits = ["minutes_per_unit", "units_per_hour", "seconds_per_unit"] as const;
export type OperationTimeUnit = (typeof operationTimeUnits)[number];

// Alternativa resurser (#15): one alternative resource of an own routing
// operation. The times are minutes like the operation's; null/omitted = som
// ordinarie (the operation's own time, read at every use).
export const routingAlternativeSchema = z.object({
  workCenterId: z.string().uuid(),
  setupTime: blankSafe(z.coerce.number().nonnegative().max(numericMax(10, 2))).nullable().optional(),
  runTimePerUnit: blankSafe(z.coerce.number().nonnegative().max(numericMax(10, 4))).nullable().optional(),
});
export type RoutingAlternativeInput = z.infer<typeof routingAlternativeSchema>;
export const MAX_ROUTING_ALTERNATIVES = 5;
// The whole set in rank order (the list's order is the rank). Sent, it
// replaces the operation's alternatives in the same transaction as the
// operation; omitted, they are left as they are. The service holds the
// rules that need the resources (not the ordinarie, no legoresurs, not on a
// lego or Kalkyl operation, a new one active).
const routingAlternativesSchema = z
  .array(routingAlternativeSchema)
  .max(MAX_ROUTING_ALTERNATIVES)
  .refine((rows) => new Set(rows.map((r) => r.workCenterId)).size === rows.length, "En resurs kan bara vara alternativ en gång");

// articleId comes from the URL (/articles/:id/routing), matching createBomComponentSchema.
// Ritningar per operation (0200): ids of the operation's own article's
// drawings (article_drawings), unique.
export const routingDrawingIdsSchema = z
  .array(z.string().uuid())
  .max(50)
  .refine((ids) => new Set(ids).size === ids.length, "Samma ritning kan bara väljas en gång");

// Filer per operation (0201): ids of the article's loose files (article_files
// without a drawing revision), unique.
export const routingFileIdsSchema = z
  .array(z.string().uuid())
  .max(50)
  .refine((ids) => new Set(ids).size === ids.length, "Samma fil kan bara väljas en gång");

export const createRoutingOperationSchema = z.object({
  sequenceNo: blankSafe(z.coerce.number().int().positive().max(INT4_MAX)),
  // Optional — every surface falls back to the resource name when it is
  // missing, so a routing imported without it reads exactly as before.
  description: routingDescriptionSchema.optional(),
  workCenterId: z.string().uuid(),
  setupTime: blankSafe(z.coerce.number().nonnegative().max(numericMax(10, 2))),
  runTimePerUnit: blankSafe(z.coerce.number().nonnegative().max(numericMax(10, 4))),
  // "Cykeltid" — productive time, minutes per unit like runTimePerUnit; null = none.
  cycleTimePerUnit: blankSafe(z.coerce.number().nonnegative().max(numericMax(10, 4))).nullable().optional(),
  timeUnit: z.enum(operationTimeUnits).optional(),
  // "Kalkyl" — time counted in the pre-calculation only; the operation is
  // skipped when the routing is snapshotted at release.
  costingOnly: z.boolean().optional(),
  // Printed on the work card only when printOnWorkCard is set.
  comment: routingCommentSchema.optional(),
  printOnWorkCard: z.boolean().optional(),
  // Always printed on the work card when set — see schema comment above.
  packingInstructions: routingPackingInstructionsSchema.optional(),
  // --- Lego (subcontract) fields — meaningful only when the chosen work
  // center is a legoresurs; the service refuses them on other resources. ---
  subcontractSupplierId: z.string().uuid().nullable().optional(),
  setupPrice: blankSafe(z.coerce.number().nonnegative().max(numericMax(12, 2))).nullable().optional(),
  // Transportkostnad (lego) — added to the ställpris on the lego IO and in the costing.
  transportPrice: blankSafe(z.coerce.number().nonnegative().max(numericMax(12, 2))).nullable().optional(),
  unitPrice: blankSafe(z.coerce.number().nonnegative().max(numericMax(12, 4))).nullable().optional(),
  showNetWeight: z.boolean().optional(),
  useArticleDrawing: z.boolean().optional(),
  // Alternativa resurser — see routingAlternativesSchema.
  alternatives: routingAlternativesSchema.optional(),
  // Ritningar (0200): the article's drawings the operation is worked from —
  // sent = the whole set, omitted = unchanged (none on a new operation).
  drawingIds: routingDrawingIdsSchema.optional(),
  // Filer (0201): the article's loose files the operation is worked from —
  // sent = the whole set, omitted = unchanged.
  fileIds: routingFileIdsSchema.optional(),
});
export type CreateRoutingOperationInput = z.infer<typeof createRoutingOperationSchema>;

export const updateRoutingOperationSchema = z
  .object({
    sequenceNo: blankSafe(z.coerce.number().int().positive().max(INT4_MAX)).optional(),
    description: routingDescriptionSchema.optional(),
    workCenterId: z.string().uuid().optional(),
    setupTime: blankSafe(z.coerce.number().nonnegative().max(numericMax(10, 2))).optional(),
    runTimePerUnit: blankSafe(z.coerce.number().nonnegative().max(numericMax(10, 4))).optional(),
    // "Cykeltid"; null clears.
    cycleTimePerUnit: blankSafe(z.coerce.number().nonnegative().max(numericMax(10, 4))).nullable().optional(),
    timeUnit: z.enum(operationTimeUnits).optional(),
    costingOnly: z.boolean().optional(),
    // Nullable so the comment can be cleared.
    comment: routingCommentSchema.optional(),
    printOnWorkCard: z.boolean().optional(),
    // Nullable so the packing instructions can be cleared.
    packingInstructions: routingPackingInstructionsSchema.optional(),
    // Lego fields — nullable so switching back to an ordinary resource can
    // clear them.
    subcontractSupplierId: z.string().uuid().nullable().optional(),
    setupPrice: blankSafe(z.coerce.number().nonnegative().max(numericMax(12, 2))).nullable().optional(),
    transportPrice: blankSafe(z.coerce.number().nonnegative().max(numericMax(12, 2))).nullable().optional(),
    unitPrice: blankSafe(z.coerce.number().nonnegative().max(numericMax(12, 4))).nullable().optional(),
    showNetWeight: z.boolean().optional(),
    useArticleDrawing: z.boolean().optional(),
    // Alternativa resurser — sent = the whole new set, omitted = unchanged.
    alternatives: routingAlternativesSchema.optional(),
    drawingIds: routingDrawingIdsSchema.optional(),
    fileIds: routingFileIdsSchema.optional(),
  })
  .refine((data) => Object.keys(data).length > 0, "At least one field must be provided");
export type UpdateRoutingOperationInput = z.infer<typeof updateRoutingOperationSchema>;

// --- Ändra material och operationer på en skapad TO (released/in_progress) ---
// The TO's own rows are edited, never the article's BOM/routing.

// POST /manufacturing-orders/:id/materials — quantity is entered in `unitId`
// (one of the COMPONENT's units, null/omitted = its base unit) and stored
// in the base unit with the factor snapshotted, exactly like a BOM row.
// moOperationId null/omitted = not tied to an operation (drawn at receipt).
export const createMoMaterialSchema = z.object({
  componentArticleId: z.string().uuid(),
  quantity: blankSafe(z.coerce.number().positive().max(numericMax(14, 4))),
  unitId: z.string().uuid().nullable().optional(),
  moOperationId: z.string().uuid().nullable().optional(),
});
export type CreateMoMaterialInput = z.infer<typeof createMoMaterialSchema>;

// PATCH …/materials/:rowId — quantity is interpreted in the row's unit, or
// in the newly given unitId. A component swap resets the unit to the new
// component's base unit unless unitId is given alongside.
export const updateMoMaterialSchema = z
  .object({
    quantity: blankSafe(z.coerce.number().positive().max(numericMax(14, 4))).optional(),
    unitId: z.string().uuid().nullable().optional(),
    moOperationId: z.string().uuid().nullable().optional(),
    componentArticleId: z.string().uuid().optional(),
  })
  .refine((data) => Object.keys(data).length > 0, "At least one field must be provided");
export type UpdateMoMaterialInput = z.infer<typeof updateMoMaterialSchema>;

// POST /manufacturing-orders/:id/operations — the routing operation's fields
// minus costingOnly (a Kalkyl operation never exists on a TO) and
// useArticleDrawing (a TO operation has no routing row to read it from).
export const createMoOperationSchema = z.object({
  sequenceNo: blankSafe(z.coerce.number().int().positive().max(INT4_MAX)),
  description: routingDescriptionSchema.optional(),
  workCenterId: z.string().uuid(),
  setupTime: blankSafe(z.coerce.number().nonnegative().max(numericMax(10, 2))),
  runTimePerUnit: blankSafe(z.coerce.number().nonnegative().max(numericMax(10, 4))),
  timeUnit: z.enum(operationTimeUnits).optional(),
  comment: routingCommentSchema.optional(),
  printOnWorkCard: z.boolean().optional(),
  packingInstructions: routingPackingInstructionsSchema.optional(),
  subcontractSupplierId: z.string().uuid().nullable().optional(),
  setupPrice: blankSafe(z.coerce.number().nonnegative().max(numericMax(12, 2))).nullable().optional(),
  // Transportkostnad (lego) — added to the ställpris on the lego IO and in the costing.
  transportPrice: blankSafe(z.coerce.number().nonnegative().max(numericMax(12, 2))).nullable().optional(),
  unitPrice: blankSafe(z.coerce.number().nonnegative().max(numericMax(12, 4))).nullable().optional(),
  showNetWeight: z.boolean().optional(),
});
export type CreateMoOperationInput = z.infer<typeof createMoOperationSchema>;

export const updateMoOperationSchema = z
  .object({
    sequenceNo: blankSafe(z.coerce.number().int().positive().max(INT4_MAX)).optional(),
    description: routingDescriptionSchema.optional(),
    workCenterId: z.string().uuid().optional(),
    setupTime: blankSafe(z.coerce.number().nonnegative().max(numericMax(10, 2))).optional(),
    runTimePerUnit: blankSafe(z.coerce.number().nonnegative().max(numericMax(10, 4))).optional(),
    timeUnit: z.enum(operationTimeUnits).optional(),
    comment: routingCommentSchema.optional(),
    printOnWorkCard: z.boolean().optional(),
    packingInstructions: routingPackingInstructionsSchema.optional(),
    subcontractSupplierId: z.string().uuid().nullable().optional(),
    setupPrice: blankSafe(z.coerce.number().nonnegative().max(numericMax(12, 2))).nullable().optional(),
    transportPrice: blankSafe(z.coerce.number().nonnegative().max(numericMax(12, 2))).nullable().optional(),
    unitPrice: blankSafe(z.coerce.number().nonnegative().max(numericMax(12, 4))).nullable().optional(),
    showNetWeight: z.boolean().optional(),
    // "Vald för hand" (alternativa resurser). A switch to one of the
    // operation's resources sets it unless false is sent; false alone gives
    // the operation suggestions again. Ignored on an operation without
    // resource rows (it is always false there).
    resourceLocked: z.boolean().optional(),
    // Byt till X's precondition (#15): the resource the planner saw the
    // förslag on. The switch is refused (409 mo-operation-resource-changed)
    // when the operation is no longer on it, or has been moved (Flyttad,
    // plan_locked) since — a förslag is only ever made for an unlocked
    // operation. Ändra does not send it.
    expectedWorkCenterId: z.string().uuid().optional(),
  })
  .refine((data) => Object.keys(data).length > 0, "At least one field must be provided");
export type UpdateMoOperationInput = z.infer<typeof updateMoOperationSchema>;

// Header only — material consumption rows and operations are derived from
// the article's BOM and Routing at release time, not supplied here.
// E3: salesOrderRowId links the TO to a KO row (KO→TO-koppling). When set,
// articleId may be omitted — it's derived from the row's own article — but
// if both are given they must agree (checked in the manufacturing service).
export const createManufacturingOrderSchema = z
  .object({
    articleId: z.string().uuid().optional(),
    quantity: blankSafe(z.coerce.number().positive().max(numericMax(14, 4))),
    note: z.string().optional(),
    salesOrderRowId: z.string().uuid().optional(),
    // Planerat färdigdatum (E2 beläggning) — optional; load lands in this week.
    dueDate: z.string().date().nullable().optional(),
    // Konfigurator 4c: the choices of a beställningsvara TO made without a
    // sales order row (Ny tillverkningsorder). With salesOrderRowId the row
    // owns the choices and this must be absent (400).
    configuration: z.object({ selection: configuratorSelectionSchema.default({}) }).optional(),
    // Avvikelser: the deviation this document is created for (Skapa
    // kreditfaktura/ersättningsorder/inköpsorder/tillverkningsorder) — linked in
    // deviation_links in the document's own create transaction; needs Kvalitet.
    deviationId: z.string().uuid().optional(),
  })
  .refine((data) => data.articleId !== undefined || data.salesOrderRowId !== undefined, {
    message: "articleId is required unless salesOrderRowId is given",
    path: ["articleId"],
  });
export type CreateManufacturingOrderInput = z.infer<typeof createManufacturingOrderSchema>;

// Header PATCH — today only the planned finish date is editable this way;
// everything else on the MO moves through status transitions.
export const updateManufacturingOrderSchema = z.object({
  dueDate: z.string().date().nullable(),
});
export type UpdateManufacturingOrderInput = z.infer<typeof updateManufacturingOrderSchema>;

// E3: POST /sales-orders/:id/rows/:rowId/manufacturing-order — quantity is
// optional, defaulting to the row's remaining (uncovered) balance in the
// service. dueDate is the dialog's Planerat färdigdatum (prefilled from
// GET /articles/:id/due-date-suggestion?salesOrderRowId=); omitted = none.
export const createFromSalesOrderRowSchema = z.object({
  quantity: blankSafe(z.coerce.number().positive().max(numericMax(14, 4))).optional(),
  dueDate: z.string().date().nullable().optional(),
});
export type CreateFromSalesOrderRowInput = z.infer<typeof createFromSalesOrderRowSchema>;

// Materialbrist vid rapportering: the system setting
// manufacturing_material_shortage decides what happens when a report draws
// more component material than is in stock. In mode "warn" the API answers
// 409 material-shortage and the client resubmits with this flag set to
// report anyway; in "block" the flag is ignored, in "none" nothing is checked.
export const materialShortageOverrideSchema = z.boolean().optional();

export const consumeMaterialSchema = z.object({
  locationId: z.string().uuid().optional(),
  quantity: blankSafe(z.coerce.number().positive().max(numericMax(14, 4))),
  allowMaterialShortage: materialShortageOverrideSchema,
});
export type ConsumeMaterialInput = z.infer<typeof consumeMaterialSchema>;

// quantityCompleted is the OK quantity for THIS report (omitted = what
// remains of the order quantity); quantityScrapped adds scrapped units,
// which also consume the operation's linked material. Over-reporting is
// allowed on purpose — it draws extra material.
export const completeOperationSchema = z
  .object({
    actualTime: blankSafe(z.coerce.number().nonnegative().max(numericMax(10, 2))).optional(),
    quantityCompleted: blankSafe(z.coerce.number().nonnegative().max(numericMax(14, 4))).optional(),
    quantityScrapped: blankSafe(z.coerce.number().nonnegative().max(numericMax(14, 4))).default(0),
    scrapReason: z.string().trim().max(500).optional(),
    // Kvalitet: the Avvikelseorsak (applies_scrap) — required by the API when
    // the register has an active scrap reason; scrapReason is then the
    // optional comment. Without any such reason the free text is the reason.
    scrapReasonId: z.string().uuid().optional(),
    locationId: z.string().uuid().optional(),
    allowMaterialShortage: materialShortageOverrideSchema,
  })
  .refine((data) => data.quantityScrapped === 0 || data.scrapReasonId !== undefined || (data.scrapReason ?? "").length > 0, {
    message: "Ange en kassationsorsak när kasserat antal är större än 0",
    path: ["scrapReason"],
  });
export type CompleteOperationInput = z.infer<typeof completeOperationSchema>;

export const completeManufacturingOrderSchema = z.object({
  locationId: z.string().uuid().optional(),
  // What to receive NOW, on top of any delinleverans from the last operation.
  // Omitted = what remains of the order quantity; 0 closes a short order
  // (scrap kept it from reaching the quantity) without receiving more.
  quantity: blankSafe(z.coerce.number().nonnegative().max(numericMax(14, 4))).optional(),
  allowMaterialShortage: materialShortageOverrideSchema,
});
export type CompleteManufacturingOrderInput = z.infer<typeof completeManufacturingOrderSchema>;

// Pallkort (pallet card) — the quantity printed on the card. Omitted, the
// service falls back to the operation's accumulated OK quantity (the
// report's OK quantity on the report route) and prints ONE card. Repeated
// (`?quantity=10&quantity=10&quantity=4`) ⇒ one card per kolli with that
// quantity, in that order, 1–50 cards; Fastify hands a single value as a
// string and several as an array, both normalised to a list. The server
// never checks that the kolli add up to the total — the dialog warns.
export const palletCardQuantitiesSchema = z.preprocess(
  (value) => (value === undefined ? undefined : Array.isArray(value) ? value : [value]),
  z.array(z.coerce.number().positive()).min(1).max(50).optional()
);
export const palletCardQuerySchema = z.object({
  quantity: palletCardQuantitiesSchema,
});
export type PalletCardQuery = z.infer<typeof palletCardQuerySchema>;

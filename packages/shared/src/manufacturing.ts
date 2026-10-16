import { z } from "zod";
import { optionalText } from "./coerce.js";
import { configuratorSelectionSchema } from "./configurator.js";
import { listQuerySchema, statusListParam } from "./list.js";

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
  status: statusListParam(manufacturingOrderStatusSchema.options),
  // Adds an `operations` summary (sequence, status, work center, production
  // group) to each row, e.g. for integrations. An extra batched query, so
  // it's opt-in. Same "true"/"false" string pattern as withOpenRows in sales.ts.
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
  hourlyRate: z.coerce.number().nonnegative().default(0),
  overheadPercent: z.coerce.number().nonnegative().default(0),
  // E2 capacity: available time = the week schedule's resolved net hours for
  // the actual week × capacityFactor (e.g. 2 = two machines/people). No
  // schedule = no capacity shown in beläggningen. Factor 0 is rejected —
  // clear the schedule instead.
  weekScheduleId: z.string().uuid().nullable().optional(),
  capacityFactor: z.coerce.number().positive().default(1),
  // Legoresurs only: the resource's default supplier, prefilled on new lego
  // operations in the beredning.
  supplierId: z.string().uuid().nullable().optional(),
  active: z.boolean().default(true),
  // Monitor G5 resource defaults (imported, editable, not yet consumed by
  // the beredning). All optional/nullable — see work_centers' comment.
  defaultSetupTime: z.coerce.number().nonnegative().nullable().optional(),
  defaultOperationName: z.string().max(100).nullable().optional(),
  rateAppliesToSetup: z.boolean().nullable().optional(),
  rateAppliesToRun: z.boolean().nullable().optional(),
  calcRate1: z.coerce.number().nonnegative().nullable().optional(),
  // Legoresurs only (days).
  leadTimeDays: z.coerce.number().nonnegative().nullable().optional(),
  queueTimeDays: z.coerce.number().nonnegative().nullable().optional(),
  orderLeadTimeDays: z.coerce.number().nonnegative().nullable().optional(),
});
export type CreateWorkCenterInput = z.infer<typeof createWorkCenterSchema>;

export const updateWorkCenterSchema = z
  .object({
    code: workCenterCodeSchema.optional(),
    name: z.string().min(1).max(100).optional(),
    type: z.enum(workCenterTypes).optional(),
    productionGroupId: z.string().uuid().nullable().optional(),
    hourlyRate: z.coerce.number().nonnegative().optional(),
    overheadPercent: z.coerce.number().nonnegative().optional(),
    weekScheduleId: z.string().uuid().nullable().optional(),
    capacityFactor: z.coerce.number().positive().optional(),
    supplierId: z.string().uuid().nullable().optional(),
    active: z.boolean().optional(),
    defaultSetupTime: z.coerce.number().nonnegative().nullable().optional(),
    defaultOperationName: z.string().max(100).nullable().optional(),
    rateAppliesToSetup: z.boolean().nullable().optional(),
    rateAppliesToRun: z.boolean().nullable().optional(),
    calcRate1: z.coerce.number().nonnegative().nullable().optional(),
    leadTimeDays: z.coerce.number().nonnegative().nullable().optional(),
    queueTimeDays: z.coerce.number().nonnegative().nullable().optional(),
    orderLeadTimeDays: z.coerce.number().nonnegative().nullable().optional(),
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
export const operationTimeUnits = ["minutes_per_unit", "units_per_hour"] as const;

// articleId comes from the URL (/articles/:id/routing), matching createBomComponentSchema.
export const createRoutingOperationSchema = z.object({
  sequenceNo: z.coerce.number().int().positive(),
  // Optional — every surface falls back to the resource name when it is
  // missing, so a routing imported without it reads exactly as before.
  description: routingDescriptionSchema.optional(),
  workCenterId: z.string().uuid(),
  setupTime: z.coerce.number().nonnegative(),
  runTimePerUnit: z.coerce.number().nonnegative(),
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
  setupPrice: z.coerce.number().nonnegative().nullable().optional(),
  unitPrice: z.coerce.number().nonnegative().nullable().optional(),
  showNetWeight: z.boolean().optional(),
  useArticleDrawing: z.boolean().optional(),
});
export type CreateRoutingOperationInput = z.infer<typeof createRoutingOperationSchema>;

export const updateRoutingOperationSchema = z
  .object({
    sequenceNo: z.coerce.number().int().positive().optional(),
    description: routingDescriptionSchema.optional(),
    workCenterId: z.string().uuid().optional(),
    setupTime: z.coerce.number().nonnegative().optional(),
    runTimePerUnit: z.coerce.number().nonnegative().optional(),
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
    setupPrice: z.coerce.number().nonnegative().nullable().optional(),
    unitPrice: z.coerce.number().nonnegative().nullable().optional(),
    showNetWeight: z.boolean().optional(),
    useArticleDrawing: z.boolean().optional(),
  })
  .refine((data) => Object.keys(data).length > 0, "At least one field must be provided");
export type UpdateRoutingOperationInput = z.infer<typeof updateRoutingOperationSchema>;

// Header only — material consumption rows and operations are derived from
// the article's BOM and Routing at release time, not supplied here.
// E3: salesOrderRowId links the TO to a KO row (KO→TO-koppling). When set,
// articleId may be omitted — it's derived from the row's own article — but
// if both are given they must agree (checked in the manufacturing service).
export const createManufacturingOrderSchema = z
  .object({
    articleId: z.string().uuid().optional(),
    quantity: z.coerce.number().positive(),
    note: z.string().optional(),
    salesOrderRowId: z.string().uuid().optional(),
    // Planerat färdigdatum (E2 beläggning) — optional; load lands in this week.
    dueDate: z.string().date().nullable().optional(),
    // Konfigurator 4c: the choices of a beställningsvara TO made without a
    // sales order row (Ny tillverkningsorder). With salesOrderRowId the row
    // owns the choices and this must be absent (400).
    configuration: z.object({ selection: configuratorSelectionSchema.default({}) }).optional(),
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
  quantity: z.coerce.number().positive().optional(),
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
  quantity: z.coerce.number().positive(),
  allowMaterialShortage: materialShortageOverrideSchema,
});
export type ConsumeMaterialInput = z.infer<typeof consumeMaterialSchema>;

// quantityCompleted is the OK quantity for THIS report (omitted = what
// remains of the order quantity); quantityScrapped adds scrapped units,
// which also consume the operation's linked material. Over-reporting is
// allowed on purpose — it draws extra material.
export const completeOperationSchema = z
  .object({
    actualTime: z.coerce.number().nonnegative().optional(),
    quantityCompleted: z.coerce.number().nonnegative().optional(),
    quantityScrapped: z.coerce.number().nonnegative().default(0),
    scrapReason: z.string().trim().max(500).optional(),
    locationId: z.string().uuid().optional(),
    allowMaterialShortage: materialShortageOverrideSchema,
  })
  .refine((data) => data.quantityScrapped === 0 || (data.scrapReason ?? "").length > 0, {
    message: "Ange en kassationsorsak när kasserat antal är större än 0",
    path: ["scrapReason"],
  });
export type CompleteOperationInput = z.infer<typeof completeOperationSchema>;

export const completeManufacturingOrderSchema = z.object({
  locationId: z.string().uuid().optional(),
  // What to receive NOW, on top of any delinleverans from the last operation.
  // Omitted = what remains of the order quantity; 0 closes a short order
  // (scrap kept it from reaching the quantity) without receiving more.
  quantity: z.coerce.number().nonnegative().optional(),
  allowMaterialShortage: materialShortageOverrideSchema,
});
export type CompleteManufacturingOrderInput = z.infer<typeof completeManufacturingOrderSchema>;

// Pallkort (pallet card) — the quantity printed on the card. Omitted, the
// service falls back to the operation's accumulated OK quantity, then the
// order quantity.
export const palletCardQuerySchema = z.object({
  quantity: z.coerce.number().positive().optional(),
});
export type PalletCardQuery = z.infer<typeof palletCardQuerySchema>;

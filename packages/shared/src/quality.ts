import { z } from "zod";
import { blankSafe, optionalText } from "./coerce.js";
import { listQuerySchema } from "./list.js";
import { sendDocumentEmailSchema } from "./mail.js";

// Reklamationer och avvikelser (Kvalitet, migration 0153) — the shared
// contract: the enums with their Swedish labels and the zod schemas of the
// /deviations routes and the Avvikelseorsaker register. The status whitelist
// itself is the API's (quality/service/deviation-status.ts); the card reads
// allowedTransitions from GET /deviations/:id.

export const DEVIATION_TYPES = ["customer", "supplier", "internal"] as const;
export type DeviationType = (typeof DEVIATION_TYPES)[number];
export const DEVIATION_TYPE_LABELS: Record<DeviationType, string> = {
  customer: "Kundreklamation",
  supplier: "Leverantörsavvikelse",
  internal: "Intern avvikelse",
};

export const DEVIATION_STATUSES = ["registered", "investigating", "closed", "cancelled"] as const;
export type DeviationStatus = (typeof DEVIATION_STATUSES)[number];
export const DEVIATION_STATUS_LABELS: Record<DeviationStatus, string> = {
  registered: "Registrerad",
  investigating: "Utreds",
  closed: "Avslutad",
  cancelled: "Makulerad",
};
// Open = still being worked on; the list's default and Åtgärd senast's scope.
export const DEVIATION_OPEN_STATUSES = ["registered", "investigating"] as const satisfies readonly DeviationStatus[];

export const DEVIATION_DECISIONS = ["accepted", "rejected"] as const;
export type DeviationDecision = (typeof DEVIATION_DECISIONS)[number];
export const DEVIATION_DECISION_LABELS: Record<DeviationDecision, string> = {
  accepted: "Godkänd",
  rejected: "Avslagen",
};

// Material, Arbete, Frakt, Kreditering, Övrigt add to the net cost;
// Ersättning (e.g. the supplier's credit) reduces it.
export const DEVIATION_COST_KINDS = ["material", "labour", "freight", "credit", "other", "recovery"] as const;
export type DeviationCostKind = (typeof DEVIATION_COST_KINDS)[number];
export const DEVIATION_COST_KIND_LABELS: Record<DeviationCostKind, string> = {
  material: "Material",
  labour: "Arbete",
  freight: "Frakt",
  credit: "Kreditering",
  other: "Övrigt",
  recovery: "Ersättning",
};

export const DEVIATION_LINK_DOCUMENT_TYPES = [
  "credit_invoice",
  "sales_order",
  "purchase_order",
  "manufacturing_order",
  "supplier_invoice",
] as const;
export type DeviationLinkDocumentType = (typeof DEVIATION_LINK_DOCUMENT_TYPES)[number];
export const DEVIATION_LINK_DOCUMENT_LABELS: Record<DeviationLinkDocumentType, string> = {
  credit_invoice: "Kreditfaktura",
  sales_order: "Kundorder",
  purchase_order: "Inköpsorder",
  manufacturing_order: "Tillverkningsorder",
  supplier_invoice: "Leverantörsfaktura",
};

export const DEVIATION_EVENTS = [
  "created",
  "status_changed",
  "updated",
  "cost_added",
  "cost_removed",
  "link_added",
  "link_removed",
  "file_added",
  "file_removed",
  "email_sent",
] as const;
export type DeviationEvent = (typeof DEVIATION_EVENTS)[number];

// The status actions (POST /deviations/:id/<action>).
export const DEVIATION_ACTIONS = ["start", "close", "cancel", "reopen"] as const;
export type DeviationAction = (typeof DEVIATION_ACTIONS)[number];
export const DEVIATION_ACTION_LABELS: Record<DeviationAction, string> = {
  start: "Börja utreda",
  close: "Avsluta",
  cancel: "Makulera",
  reopen: "Öppna igen",
};

// --- Avvikelseorsaker (register) ---

// Same code rule as Förlustorsaker: upper-case letters and digits, max 10
// (lower case is upper-cased). At least one "applies to" flag.
export const deviationReasonInputSchema = z
  .object({
    code: z
      .string()
      .trim()
      .transform((value) => value.toUpperCase())
      .pipe(z.string().regex(/^[A-Z0-9]{1,10}$/, "Koden får bara innehålla versaler och siffror, högst 10 tecken")),
    name: z.string().trim().min(1).max(100),
    appliesCustomer: z.boolean().default(false),
    appliesSupplier: z.boolean().default(false),
    appliesInternal: z.boolean().default(false),
    appliesScrap: z.boolean().default(false),
    active: z.boolean().default(true),
  })
  .refine((r) => r.appliesCustomer || r.appliesSupplier || r.appliesInternal || r.appliesScrap, {
    message: "Välj minst en av Kund, Leverantör, Intern och Kassation",
    path: ["appliesCustomer"],
  });
export type DeviationReasonInput = z.infer<typeof deviationReasonInputSchema>;

// --- Avvikelser ---

const uuidRef = z.string().uuid().nullable().optional();
const longText = optionalText(10000).optional();

const deviationFields = {
  title: z.string().trim().min(1).max(200),
  description: longText,
  // Stockholm day; omitted on create = today.
  reportedDate: z.string().date(),
  reasonId: uuidRef,
  responsibleUserId: uuidRef,
  dueDate: z.string().date().nullable().optional(),
  customerId: uuidRef,
  supplierId: uuidRef,
  counterpartyReference: optionalText(100).optional(),
  salesOrderId: uuidRef,
  salesOrderRowId: uuidRef,
  invoiceId: uuidRef,
  purchaseOrderId: uuidRef,
  purchaseOrderRowId: uuidRef,
  manufacturingOrderId: uuidRef,
  moOperationId: uuidRef,
  articleId: uuidRef,
  // In the article's base (stock) unit.
  quantity: blankSafe(z.coerce.number().positive().max(1e9)).nullable().optional(),
  causeAnalysis: longText,
  correctiveAction: longText,
  preventiveAction: longText,
};

export const createDeviationSchema = z.object({
  type: z.enum(DEVIATION_TYPES),
  ...deviationFields,
  reportedDate: deviationFields.reportedDate.optional(),
});
export type CreateDeviationInput = z.infer<typeof createDeviationSchema>;

// The type never changes after creation. Beslut may be set ahead of Avsluta
// (customer/supplier only).
export const updateDeviationSchema = z
  .object({ ...deviationFields, decision: z.enum(DEVIATION_DECISIONS).nullable().optional() })
  .partial();
export type UpdateDeviationInput = z.infer<typeof updateDeviationSchema>;

// Avsluta: Beslut required for customer and supplier cases unless already set.
export const closeDeviationSchema = z.object({ decision: z.enum(DEVIATION_DECISIONS).optional() });
export type CloseDeviationInput = z.infer<typeof closeDeviationSchema>;

export const cancelDeviationSchema = z.object({ reason: z.string().trim().min(1).max(500) });
export type CancelDeviationInput = z.infer<typeof cancelDeviationSchema>;

export const createDeviationCostSchema = z.object({
  kind: z.enum(DEVIATION_COST_KINDS),
  description: optionalText(200).optional(),
  // SEK, rounded to öre by the API.
  amount: blankSafe(z.coerce.number().positive().max(1e10)),
});
export type CreateDeviationCostInput = z.infer<typeof createDeviationCostSchema>;

export const createDeviationLinkSchema = z.object({
  documentType: z.enum(DEVIATION_LINK_DOCUMENT_TYPES),
  documentId: z.string().uuid(),
});
export type CreateDeviationLinkInput = z.infer<typeof createDeviationLinkSchema>;

// "1"/"true" ⇒ true; anything else (absent, "0", "false") ⇒ false. Not
// z.coerce.boolean(), which turns "false" into true.
const flagParam = z
  .enum(["1", "0", "true", "false"])
  .optional()
  .transform((v) => v === "1" || v === "true");

// status: omitted or "open" ⇒ registered + investigating; "all" ⇒ every
// status (null); otherwise a comma-separated list of statuses.
const deviationStatusParam = z
  .string()
  .optional()
  .transform((raw, ctx): DeviationStatus[] | null => {
    const value = raw?.trim() ?? "";
    if (value === "" || value === "open") return [...DEVIATION_OPEN_STATUSES];
    if (value === "all") return null;
    const parts = value.split(",").map((p) => p.trim()).filter((p) => p !== "");
    const invalid = parts.filter((p) => !(DEVIATION_STATUSES as readonly string[]).includes(p));
    if (invalid.length > 0) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: `Invalid status: ${invalid.join(", ")}` });
      return z.NEVER;
    }
    return parts as DeviationStatus[];
  });

export const listDeviationsQuerySchema = listQuerySchema.extend({
  type: z.enum(DEVIATION_TYPES).optional(),
  status: deviationStatusParam,
  reasonId: z.string().uuid().optional(),
  customerId: z.string().uuid().optional(),
  supplierId: z.string().uuid().optional(),
  articleId: z.string().uuid().optional(),
  salesOrderId: z.string().uuid().optional(),
  invoiceId: z.string().uuid().optional(),
  purchaseOrderId: z.string().uuid().optional(),
  manufacturingOrderId: z.string().uuid().optional(),
  responsibleUserId: z.string().uuid().optional(),
  // Åtgärd senast has passed (open cases only).
  overdue: flagParam,
  // Datum (reported_date), inclusive.
  from: z.string().date().optional(),
  to: z.string().date().optional(),
});
export type ListDeviationsQuery = z.infer<typeof listDeviationsQuerySchema>;

// GET /deviations/:id/pdf?details=1 — with Orsaksanalys, Åtgärd,
// Förebyggande åtgärd and Beslut.
export const deviationPdfQuerySchema = z.object({ details: flagParam });

// POST /deviations/:id/email — the document mail with the same choice.
export const sendDeviationEmailSchema = sendDocumentEmailSchema.omit({ attachDrawings: true }).extend({
  includeDetails: z.boolean().default(false),
});
export type SendDeviationEmailInput = z.infer<typeof sendDeviationEmailSchema>;

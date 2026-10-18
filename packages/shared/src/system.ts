import { z } from "zod";
import { costingMaterialSourceSchema, costingSupplierPriceTierSchema } from "./costing.js";
import { deliveryDayModeSchema, transitDaysSchema } from "./delivery.js";

// Materialbrist vid rapportering — see updateSystemSettingsSchema below.
export const manufacturingMaterialShortageSchema = z.enum(["none", "warn", "block"]);
export type ManufacturingMaterialShortage = z.infer<typeof manufacturingMaterialShortageSchema>;

export const updateCompanyInfoSchema = z
  .object({
    name: z.string().min(1).max(255).optional(),
    orgNumber: z.string().max(20).nullable().optional(),
    address: z.string().max(255).nullable().optional(),
    postalCode: z.string().max(20).nullable().optional(),
    city: z.string().max(100).nullable().optional(),
    phone: z.string().max(50).nullable().optional(),
    email: z.string().email().max(255).nullable().optional(),
    website: z.string().max(255).nullable().optional(),
    // Payment/registration details printed in the footer of outgoing
    // documents (inquiry, purchase order, quote, order confirmation).
    bankgiro: z.string().max(20).nullable().optional(),
    plusgiro: z.string().max(20).nullable().optional(),
    bankName: z.string().max(100).nullable().optional(),
    iban: z.string().max(40).nullable().optional(),
    bic: z.string().max(15).nullable().optional(),
    vatNumber: z.string().max(30).nullable().optional(),
    companySeat: z.string().max(100).nullable().optional(),
    fSkatt: z.boolean().optional(),
  })
  .refine((data) => Object.keys(data).length > 0, "At least one field must be provided");
export type UpdateCompanyInfoInput = z.infer<typeof updateCompanyInfoSchema>;

// System-wide behavior toggles, stored as key–value rows in system_settings.
// atfMinutesPerWeek is the company-wide ATF accrual (0 = ATF off); employees
// can override it individually on the personalkort.
// SMTP fields configure the external mail server used for document emails.
// smtpPassword is write-only: GET /settings answers with smtpPasswordSet
// instead, and PATCH with an empty string keeps the stored password.
const systemSettingsFieldsSchema = z.object({
    allowMultipleStamps: z.boolean().optional(),
    // Print the active article/drawing revisions per row on external
    // documents (offert/orderbekräftelse, inköpsorder, förfrågan).
    showRevisionsOnDocuments: z.boolean().optional(),
    // Print the order's own revision after the document number
    // ("Inköpsorder IO2500123 / 2") on offert/orderbekräftelse/inköpsorder.
    // Defaults ON when the key was never set.
    showOrderRevisionOnDocuments: z.boolean().optional(),
    atfMinutesPerWeek: z.number().int().min(0).max(600).optional(),
    // Daily overtime grace period (minutes) — worked time past schedule must
    // exceed this before it counts as overtime on a scheduled day. 0 = every
    // minute past schedule is overtime.
    payrollOvertimeThresholdMinutes: z.number().int().min(0).max(600).optional(),
    // PAXml löneart codes used by the payroll export — must match the
    // payroll system's own löneartstabell. An empty string is accepted (it
    // means "clear the override") and getSettings() decodes it back to the
    // Monitor-like default.
    paxmlCodeWorked: z.string().trim().max(20).optional(),
    paxmlCodeOvertime: z.string().trim().max(20).optional(),
    paxmlCodeOvertimeOffSchedule: z.string().trim().max(20).optional(),
    // Same as above, for overtime banked as comp time (komptid) instead of
    // paid out — separate löneart codes since payroll treats them differently.
    paxmlCodeOvertimeComp: z.string().trim().max(20).optional(),
    paxmlCodeOvertimeOffScheduleComp: z.string().trim().max(20).optional(),
    paxmlCodeAtf: z.string().trim().max(20).optional(),
    smtpHost: z.string().trim().max(255).optional(),
    smtpPort: z.number().int().min(1).max(65535).optional(),
    smtpSecure: z.boolean().optional(),
    smtpUser: z.string().trim().max(255).optional(),
    smtpPassword: z.string().max(255).optional(),
    smtpFromName: z.string().trim().max(255).optional(),
    smtpFromEmail: z.union([z.literal(""), z.string().trim().email().max(255)]).optional(),
    // Costing (System → Kalkyler). The markups build Monitor's påläggskalkyl:
    // dM + MO% x dM, dL + TO% x dL (TO per work center), Lego + LO% x Lego
    // = TVK, + Affo% x TVK = SVK, + generellt påslag % x SVK = sales price.
    // All default to 0 / "standard", so the calculation is unchanged until
    // someone configures it. Decimals allowed (12.5 %).
    costingMaterialSource: costingMaterialSourceSchema.optional(),
    costingSupplierPriceTier: costingSupplierPriceTierSchema.optional(),
    costingMoPercent: z.number().min(0).max(1000).optional(),
    costingLoPercent: z.number().min(0).max(1000).optional(),
    costingAffoPercent: z.number().min(0).max(1000).optional(),
    costingGeneralMarkupPercent: z.number().min(0).max(1000).optional(),
    // Tillåten överleverans på inköpsorder: how far past the ordered quantity
    // a purchase order row may be received, in percent of the row's ordered
    // quantity. null = no limit; 0 = never past the ordered quantity (the
    // behaviour before the setting existed, and the default when unset).
    purchaseOverReceiptPercent: z.number().min(0).max(1000).nullable().optional(),
    // Materialbrist vid rapportering: what a manufacturing report that draws
    // more component material than is in stock runs into — nothing ("none",
    // the behaviour before the setting existed and the default when unset),
    // a question the client can override ("warn") or a refusal ("block").
    manufacturingMaterialShortage: manufacturingMaterialShortageSchema.optional(),
    // Orimligt mycket tid: Planera and a new TO warn for an operation whose
    // remaining time alone fills its resource for more than this many normal
    // weeks. Decimals allowed; 0 = no warning; default 4 when unset.
    planningLongOperationWeeks: z.number().min(0).max(104).optional(),
    // Fasta leveransdagar: the default mode and transit days for suppliers
    // and customers without their own (delivery-days.ts decodes the keys).
    supplierDeliveryDayMode: deliveryDayModeSchema.optional(),
    supplierTransitDays: transitDaysSchema.optional(),
    customerDeliveryDayMode: deliveryDayModeSchema.optional(),
    customerTransitDays: transitDaysSchema.optional(),
    // Automatic accounting (Ekonomi → automatkontering) — BAS-styled 4-digit
    // account codes used when posting customer/supplier invoices to the
    // ledger automatically. An empty string clears the override (same
    // convention as the PAXml codes) and getSettings() decodes it back to
    // the BAS-standard default.
    postingAccountsReceivable: z.union([z.literal(""), z.string().regex(/^[0-9]{4}$/)]).optional(),
    postingVatOut25: z.union([z.literal(""), z.string().regex(/^[0-9]{4}$/)]).optional(),
    postingVatOut12: z.union([z.literal(""), z.string().regex(/^[0-9]{4}$/)]).optional(),
    postingVatOut6: z.union([z.literal(""), z.string().regex(/^[0-9]{4}$/)]).optional(),
    postingRevenue25: z.union([z.literal(""), z.string().regex(/^[0-9]{4}$/)]).optional(),
    postingRevenue12: z.union([z.literal(""), z.string().regex(/^[0-9]{4}$/)]).optional(),
    postingRevenue6: z.union([z.literal(""), z.string().regex(/^[0-9]{4}$/)]).optional(),
    postingRevenue0: z.union([z.literal(""), z.string().regex(/^[0-9]{4}$/)]).optional(),
    postingAccountsPayable: z.union([z.literal(""), z.string().regex(/^[0-9]{4}$/)]).optional(),
    postingVatIn: z.union([z.literal(""), z.string().regex(/^[0-9]{4}$/)]).optional(),
    postingDefaultCost: z.union([z.literal(""), z.string().regex(/^[0-9]{4}$/)]).optional(),
    // Kundreskontra (B3): the bank/betalkonto a customer payment is debited
    // against, the account a reminder fee is credited to, and the account for
    // öres-/kronutjämning (payment write-offs within tolerance). Same
    // 4-digit/empty-to-reset convention as the other posting accounts.
    postingBank: z.union([z.literal(""), z.string().regex(/^[0-9]{4}$/)]).optional(),
    postingReminderFeeAccount: z.union([z.literal(""), z.string().regex(/^[0-9]{4}$/)]).optional(),
    postingPaymentWriteOff: z.union([z.literal(""), z.string().regex(/^[0-9]{4}$/)]).optional(),
    // Momsrapport (B5): redovisningskonto för moms — the momsomföring's
    // counter account. Same 4-digit/empty-to-reset convention.
    postingVatSettlement: z.union([z.literal(""), z.string().regex(/^[0-9]{4}$/)]).optional(),
    // Årsbokslut (steg 2): lager och lagerförändring. Same 4-digit/"" convention.
    postingInventory: z.union([z.literal(""), z.string().regex(/^[0-9]{4}$/)]).optional(),
    postingInventoryChange: z.union([z.literal(""), z.string().regex(/^[0-9]{4}$/)]).optional(),
    // How much a payment may miss the invoice's remaining amount by and still
    // count as fully paid (kr), and the fee charged per payment reminder
    // (kr). Always required when sent — there is no "reset to default" for
    // these two (unlike the account codes, an empty amount is not valid).
    paymentTolerance: z.number().min(0).max(100000).optional(),
    reminderFee: z.number().min(0).max(100000).optional(),
  });

export const updateSystemSettingsSchema = systemSettingsFieldsSchema.refine(
  (data) => Object.keys(data).length > 0,
  "At least one field must be provided"
);
export type UpdateSystemSettingsInput = z.infer<typeof updateSystemSettingsSchema>;

// PATCH /settings/posting — exactly the keys Ekonomi → Konteringsregler
// edits (the standard accounts and the two kundreskontra amounts), so the
// Ekonomi permission can maintain them without the admin role. Strict: any
// other settings key (SMTP, PAXml, costing…) is a 400, never silently saved.
export const POSTING_SETTINGS_KEYS = [
  "postingAccountsReceivable",
  "postingVatOut25",
  "postingVatOut12",
  "postingVatOut6",
  "postingRevenue25",
  "postingRevenue12",
  "postingRevenue6",
  "postingRevenue0",
  "postingAccountsPayable",
  "postingVatIn",
  "postingDefaultCost",
  "postingBank",
  "postingReminderFeeAccount",
  "postingPaymentWriteOff",
  "postingVatSettlement",
  "postingInventory",
  "postingInventoryChange",
  "paymentTolerance",
  "reminderFee",
] as const;

export const updatePostingSettingsSchema = systemSettingsFieldsSchema
  .pick(Object.fromEntries(POSTING_SETTINGS_KEYS.map((k) => [k, true])) as { [K in (typeof POSTING_SETTINGS_KEYS)[number]]: true })
  .strict()
  .refine((data) => Object.keys(data).length > 0, "At least one field must be provided");
export type UpdatePostingSettingsInput = z.infer<typeof updatePostingSettingsSchema>;

// The company's own customer number at a carrier (Företagsinformation →
// Speditörer). The carrier link is fixed after creation — change = remove +
// add — so only the number is editable.
export const createCompanyCarrierSchema = z.object({
  carrierId: z.string().uuid(),
  customerNumber: z.string().min(1).max(50),
});
export type CreateCompanyCarrierInput = z.infer<typeof createCompanyCarrierSchema>;

export const updateCompanyCarrierSchema = z.object({
  customerNumber: z.string().min(1).max(50),
});
export type UpdateCompanyCarrierInput = z.infer<typeof updateCompanyCarrierSchema>;

// Every number series seeded by migrations. "customer" (kundnummer, no
// prefix) arrived with the customer-number feature; "supplier" (leverantörsnummer,
// no prefix) arrived with the supplier-number feature; the four keys before them
// were seeded in C1/B3/B4 but this list had fallen behind. "payment_batch"
// (BO-, betalningsomgångar) arrived with bankfiler.
export const numberSeriesKeys = [
  "purchase_order",
  "sales_order",
  "manufacturing_order",
  "inquiry",
  "invoice",
  "supplier_invoice",
  "customer_payment",
  "supplier_payment",
  "customer",
  "supplier",
  "stock_count",
  "fixed_asset",
  "payment_batch",
] as const;
export type NumberSeriesKey = (typeof numberSeriesKeys)[number];

export const updateNumberSeriesSchema = z
  .object({
    // Empty prefix is legal — the customer series prints bare numbers
    // ("1001"), and the series page always submits the field.
    prefix: z.string().max(20).optional(),
    nextNumber: z.coerce.number().int().positive().optional(),
    digits: z.coerce.number().int().min(0).max(10).optional(),
  })
  .refine((data) => Object.keys(data).length > 0, "At least one field must be provided");
export type UpdateNumberSeriesInput = z.infer<typeof updateNumberSeriesSchema>;

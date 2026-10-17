import type { ManufacturingOrderConfiguration, OrderRowConfiguration } from "./configurator";
import type { Permission } from "./permissions";
import type { VatBox, VatBoxSetting } from "./vatBoxes";
import type { FixedAssetDisposalType, FixedAssetStatus } from "./fixedAssets";
import type { YearEndAccrualKind, YearEndRole, YearEndStep } from "./yearEnd";
// Paginated list envelope — every unbounded register endpoint answers with this.
export interface Paged<T> {
  rows: T[];
  total: number;
}

export type ArticleType = "manufactured" | "purchased" | "service";

export const ARTICLE_TYPE_LABELS: Record<ArticleType, string> = {
  manufactured: "Tillverkad",
  purchased: "Köpt",
  service: "Tjänst",
};

// Swedish VAT rates (moms). MIRROR of packages/shared/src/vat.ts — the web
// app cannot import @navet/shared (Turbopack vs .js-suffix imports), so keep
// this list in sync by hand. The set is fixed by law; every web dropdown and
// label derives from this one constant.
export const VAT_RATES = [25, 12, 6, 0] as const;

export interface Article {
  id: string;
  articleNumber: string;
  name: string;
  type: ArticleType;
  isPhantom: boolean;
  // Set when the article is a configurator template (left join on the server).
  configuratorMode?: "variants" | "to_order" | null;
  // Base unit (grundenhet): code + register id. Default purchase/sales units
  // are null = the base unit; codes only on GET :id.
  unit: string;
  unitId: string;
  purchaseUnitId: string | null;
  salesUnitId: string | null;
  purchaseUnitCode?: string | null;
  salesUnitCode?: string | null;
  standardCost: string | null;
  salesPrice: string | null;
  // Default VAT rate (moms) for sales/invoice rows — inherited by invoice rows.
  vatRate: string;
  // Nettovikt (kg) and dimensions (mm).
  weight: string | null;
  length: string | null;
  width: string | null;
  height: string | null;
  // Surface treatment (ytbehandling) and colour (färg) — free text.
  surfaceTreatment: string | null;
  colour: string | null;
  // Standard packaging: base units per kolli + the kolli type (register).
  quantityPerPackage: string | null;
  packageTypeId: string | null;
  parcelKind: "package" | "pallet" | "other" | null;
  stackable: boolean;
  palletSpaces: string | null;
  loadingMeters: string | null;
  packageTypeCode?: string | null;
  packageTypeName?: string | null;
  groupId: string | null;
  groupName: string | null;
  // Default stock location — transactions without an explicit location land
  // here (null = the auto-created "***" location). Names only on GET :id.
  defaultLocationId: string | null;
  defaultLocationName?: string | null;
  defaultWarehouseName?: string | null;
  // Behovsberäkning (MRP light, E1): compared against projected stock and
  // used to round proposal quantities up to the nearest multiple.
  reorderPoint: string | null;
  orderQuantity: string | null;
  // Avrundning: the step proposals AND order-row quantities are rounded up
  // to (server-side, in the base unit, after orderQuantity). Null = none.
  rounding: string | null;
  active: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface ArticleGroup {
  id: string;
  // Exactly 3 digits; the hundreds digit forms a derived huvudgrupp
  // (310/320 belong to 300).
  code: string;
  name: string;
  description: string | null;
  createdAt: string;
}

// One alternative unit on an article: "1 base unit = quantityPerBase of this
// unit" (st article weighing 5 kg apiece → the kg row stores 5).
export interface ArticleUnit {
  id: string;
  articleId: string;
  unitId: string;
  unitCode: string;
  unitName: string;
  quantityPerBase: string;
}

export interface BomComponent {
  id: string;
  parentArticleId: string;
  componentArticleId: string;
  // Always in the component's base unit; unitCode/unitFactor say which unit
  // the row was entered in (factor null = base unit).
  quantity: string;
  unitId: string | null;
  unitFactor: string | null;
  unitCode: string;
  componentArticleNumber: string;
  componentName: string;
  componentIsPhantom: boolean;
  // Optional link to one of the parent's routing operations — the component
  // is drawn from stock when that operation is reported complete.
  routingOperationId: string | null;
  routingOperationSequenceNo: number | null;
}

// Node in GET /articles/:id/bom-tree — the structure as authored (phantoms
// stay as nodes). quantity/bomRowId are null on the root.
export interface BomTreeNode {
  articleId: string;
  articleNumber: string;
  name: string;
  isPhantom: boolean;
  quantity: string | null;
  bomRowId: string | null;
  children: BomTreeNode[];
}

export interface StockBalance {
  articleId: string;
  articleNumber: string;
  articleName: string;
  locationId: string | null;
  quantityOnHand: string;
  locationName: string | null;
  warehouseName: string | null;
}

export type StockTransactionType =
  | "purchase_receipt"
  | "sales_delivery"
  | "mo_consumption"
  | "mo_receipt"
  | "inventory_adjustment"
  | "stock_transfer";

export const STOCK_TRANSACTION_TYPE_LABELS: Record<StockTransactionType, string> = {
  purchase_receipt: "Inköpsmottagning",
  sales_delivery: "Kundleverans",
  mo_consumption: "Materialförbrukning",
  mo_receipt: "Tillverkningsmottagning",
  inventory_adjustment: "Inventeringsjustering",
  stock_transfer: "Lagerflytt",
};

// POST /api/v1/stock/transfers
export interface StockTransferResult {
  transferId: string;
  movedRows: number;
  fromLocationName: string;
  toLocationName: string;
  deactivatedSourceLocation: boolean;
}

export interface StockTransaction {
  id: string;
  articleId: string;
  articleNumber: string;
  articleName: string;
  locationId: string | null;
  locationName: string | null;
  warehouseName: string | null;
  quantityDelta: string;
  transactionType: StockTransactionType;
  referenceId: string | null;
  note: string | null;
  createdAt: string;
  // Lagerloggen: running balance (only with an article filter), who, cost.
  // unitCost/value are null for viewers without cost access (admin/ekonomi).
  balance: string | null;
  createdByName: string | null;
  unitCost: string | null;
  value: string | null;
  reference: StockTransactionReference | null;
}

// Källa — the document a log row came from.
export type StockTransactionReference =
  | { kind: "purchase_order" | "sales_order" | "manufacturing_order" | "stock_count"; id: string; number: string }
  | { kind: "manual" }
  | { kind: "transfer"; counterpartLocation: string };

// --- Lagervärdering (D1) ---

export type ValuationMethod = "standard" | "latest_purchase" | "moving_average";

export const VALUATION_METHOD_LABELS: Record<ValuationMethod, string> = {
  standard: "Standardpris",
  latest_purchase: "Senaste inköp",
  moving_average: "Vägt snitt",
};

// GET /stock/valuation[/pdf] — mirrors valuation.service.ts's ValuationRow.
// unitCost/value are null when the chosen method found no price for the
// article as of asOf; such rows are excluded from every total below
// (unvaluedCount says how many).
export interface ValuationRow {
  articleId: string;
  articleNumber: string;
  articleName: string;
  unit: string;
  active: boolean;
  quantity: number;
  unitCost: number | null;
  value: number | null;
}

export interface ValuationGroup {
  groupId: string | null;
  groupName: string;
  rows: ValuationRow[];
  // Excludes rows with value === null.
  total: number;
}

export interface ValuationResponse {
  asOf: string;
  method: ValuationMethod;
  groups: ValuationGroup[];
  // Excludes rows with value === null, same as every group total.
  totalValue: number;
  unvaluedCount: number;
}

export type CostCalculationType = "pre" | "post";

export interface CostCalculation {
  id: string;
  articleId: string;
  manufacturingOrderId: string | null;
  quantity: string;
  // Monitor's påläggskalkyl, one field per step:
  //   dM (materialCost) + MO (materialOverhead)
  // + dL (laborCost)    + TO (overhead, per work center)
  // + Lego (subcontractCost) + LO (subcontractOverhead)
  // + Halvfabrikat (semiFinishedCost — no markup of its own)
  // = TVK, + Affo (businessOverhead) = SVK, + generalMarkup = salesPrice.
  // TVK and SVK are plain sums, derived on display.
  materialCost: string;
  materialOverhead: string;
  laborCost: string;
  overhead: string;
  subcontractCost: string;
  subcontractOverhead: string;
  // Halvfabrikat — manufactured sub-assemblies costed from their own structure
  // and routing. Enters TVK without a markup of its own. "0.0000" on every
  // calculation saved before multi-level existed.
  semiFinishedCost: string;
  businessOverhead: string;
  generalMarkup: string;
  salesPrice: string;
  // The System → Kalkyler configuration this calculation ran under, so an old
  // calculation stays explainable after the settings change.
  materialSource: CostingMaterialSource;
  // Whether this run resolved manufactured sub-assemblies recursively.
  multiLevel: boolean;
  moPercent: string;
  loPercent: string;
  affoPercent: string;
  generalMarkupPercent: string;
  type: CostCalculationType;
  calculatedAt: string;
}

// Which price a material row actually used. Differs from the calculation's
// materialSource when "supplier" fell back to the standard cost.
export type CostPriceSource = "supplier" | "standard" | "none" | "calculated" | "moving_average";

export interface CostCalculationMaterialRow {
  id: string;
  componentArticleId: string;
  // "subcontract" = a service article in the structure, i.e. lego;
  // "semi" = a manufactured sub-assembly costed from its own structure.
  kind: "material" | "subcontract" | "semi";
  quantity: string;
  unitId: string | null;
  unitFactor: string | null;
  unitCost: string;
  priceSource: CostPriceSource;
  amount: string;
  articleNumber: string;
  articleName: string;
  unitCode: string;
}

export interface CostCalculationOperationRow {
  id: string;
  sequenceNo: number;
  workCenterId: string;
  hours: string;
  hourlyRate: string;
  overheadPercent: string;
  laborAmount: string;
  overheadAmount: string;
  workCenterCode: string;
  workCenterName: string;
  // Null for post-calculations and for rows saved before the column existed.
  setupHours: string | null;
}

// GET /cost-calculations/:id — header plus its specification. Calculations
// saved before the row tables existed come back with empty arrays.
export type CostCalculationDetail = CostCalculation & {
  materialRows: CostCalculationMaterialRow[];
  operationRows: CostCalculationOperationRow[];
};

// POST …/pre-calculate or …/post-calculate WITHOUT `save`: the calculation as
// it would have been saved. id and calculatedAt are null because nothing was
// written — every other field carries the real, computed value.
export type CostCalculationDraft = Omit<CostCalculation, "id" | "calculatedAt"> & {
  id: null;
  calculatedAt: null;
};

export interface Warehouse {
  id: string;
  name: string;
  active: boolean;
}

export interface StockLocation {
  id: string;
  warehouseId: string;
  name: string;
  active: boolean;
  warehouseName: string;
}

// Base-data register entry (leveransvillkor / betalningsvillkor / speditörer).
export interface RegisterEntry {
  id: string;
  code: string;
  name: string;
  // Optional free-text explanation — surfaced only on registers whose tab
  // enables it (delivery terms' Combiterms explanations today).
  description?: string | null;
  // Kollityper only (frakt) — absent on the other registers.
  parcelKind?: "package" | "pallet" | "other";
  lengthMm?: string | null;
  widthMm?: string | null;
  heightMm?: string | null;
  tareWeight?: string | null;
  stackable?: boolean;
  loadingMeters?: string | null;
  createdAt: string;
}

// Response of GET .../:id/usage — what would break if a register entry were
// deleted outright, used to offer "move these references, then delete" instead.
export interface RegisterUsage {
  total: number;
  // label = Swedish plural ("kunder"), labelOne = singular ("kund").
  references: { table: string; label: string; labelOne: string; count: number }[];
}

// Contact on a customer or supplier card; at most one per partner is primary.
export interface PartnerContact {
  id: string;
  name: string;
  phone: string | null;
  mobile: string | null;
  email: string | null;
  comment: string | null;
  isPrimary: boolean;
  createdAt: string;
}

// Terms carried by inquiries/purchase orders/sales orders — snapshotted
// from the partner at creation, editable on the document card. Codes/names
// are joined in by the detail endpoints.
export interface DocumentTermsFields {
  deliveryTermId: string | null;
  paymentTermId: string | null;
  carrierId: string | null;
  deliveryTermCode?: string | null;
  deliveryTermName?: string | null;
  paymentTermCode?: string | null;
  paymentTermName?: string | null;
  carrierCode?: string | null;
  carrierName?: string | null;
}

// Common card fields shared by customers and suppliers.
export type DeliveryDayMode = "arrival" | "dispatch";

export interface PartnerCardFields {
  address: string | null;
  postalCode: string | null;
  city: string | null;
  orgNumber: string | null;
  vatNumber: string | null;
  deliveryTermId: string | null;
  paymentTermId: string | null;
  carrierId: string | null;
  carrierCustomerNumber: string | null;
  // Fasta leveransdagar: ISO weekdays (Monday = 1); mode/transit null = the
  // system default for the side.
  deliveryWeekdays: number[];
  deliveryDayMode: DeliveryDayMode | null;
  transitDays: number | null;
  // Joined names/codes — present on the detail endpoint (GET :id) only.
  deliveryTermCode?: string | null;
  deliveryTermName?: string | null;
  paymentTermCode?: string | null;
  paymentTermName?: string | null;
  carrierCode?: string | null;
  carrierName?: string | null;
}

export interface Supplier extends PartnerCardFields, SupplierPaymentFields {
  id: string;
  supplierNumber: string;
  name: string;
  contactName: string | null;
  email: string | null;
  phone: string | null;
  // Vårt kundnummer hos leverantören — printed on inquiry/PO.
  ourCustomerNumber: string | null;
  currency: string;
  active: boolean;
  createdAt: string;
}

// Etapp C: valbara leveransadresser på leverantörskortet, samma form som
// CustomerDeliveryAddress (se nedan).
export interface SupplierDeliveryAddress {
  id: string;
  supplierId: string;
  label: string;
  address: string;
  postalCode: string | null;
  city: string | null;
  isDefault: boolean;
  createdAt: string;
}

export type PurchaseOrderStatus =
  | "draft"
  | "confirmed"
  | "partially_received"
  | "received"
  | "closed"
  | "cancelled";

// Maps to StatusPill's fixed status/color set (see components/ui/StatusPill.tsx).
export const PURCHASE_ORDER_STATUS_PILL: Record<PurchaseOrderStatus, { status: "running" | "delayed" | "stopped" | "done" | "draft"; label: string }> = {
  draft: { status: "draft", label: "Utkast" },
  confirmed: { status: "running", label: "Bekräftad" },
  partially_received: { status: "delayed", label: "Delvis mottagen" },
  received: { status: "done", label: "Mottagen" },
  closed: { status: "draft", label: "Stängd" },
  cancelled: { status: "stopped", label: "Avbruten" },
};

export interface PurchaseOrder extends DocumentTermsFields {
  id: string;
  orderNumber: string;
  supplierId: string;
  supplierName: string;
  currency: string;
  exchangeRate: string;
  status: PurchaseOrderStatus;
  expectedDeliveryDate: string | null;
  note: string | null;
  // "Frakt på vårt konto" — prints our carrier customer number on the PO.
  freightPaidByUs: boolean;
  // Er referens (leverantörens referens) / Vår referens (vår inköpare).
  yourReference: string | null;
  ourReference: string | null;
  // Bumped on every content change (header/terms/rows).
  revision: number;
  createdBy: string | null;
  createdAt: string;
  updatedAt: string;
  // Only present when the list was fetched with ?withOpenRows=true — rows
  // still short of their ordered quantity.
  openRowCount?: number;
}

// Förfrågan (RFQ) — state machine: draft → sent → answered → ordered | cancelled.
export type InquiryStatus = "draft" | "sent" | "answered" | "ordered" | "cancelled";

export const INQUIRY_STATUS_PILL: Record<InquiryStatus, { status: "running" | "delayed" | "stopped" | "done" | "draft"; label: string }> = {
  draft: { status: "draft", label: "Utkast" },
  sent: { status: "running", label: "Skickad" },
  answered: { status: "delayed", label: "Besvarad" },
  ordered: { status: "done", label: "Beställd" },
  cancelled: { status: "stopped", label: "Avbruten" },
};

export interface Inquiry extends DocumentTermsFields {
  id: string;
  inquiryNumber: string;
  supplierId: string;
  supplierName: string;
  status: InquiryStatus;
  expectedDeliveryDate: string | null;
  note: string | null;
  // "Frakt på vårt konto" — carried to the PO on convert, printed on the PDF.
  freightPaidByUs: boolean;
  purchaseOrderId: string | null;
  purchaseOrderNumber?: string | null;
  createdAt: string;
}

export interface InquiryRow {
  id: string;
  inquiryId: string;
  articleId: string;
  articleNumber: string;
  articleName: string;
  // Always stored in the article's base unit; unitCode/unitFactor say which
  // unit the row was entered in (factor null = base unit).
  quantity: string;
  unitPrice: string | null;
  unitId: string | null;
  unitFactor: string | null;
  unitCode: string;
  // --- Lego (subcontract) row: quoting an MO or routing operation. ---
  // A row is lego when moOperationId !== null || routingOperationId !== null.
  moOperationId: string | null;
  routingOperationId: string | null;
  // Ställpris — added ONCE to the row amount (qty × unitPrice + setupPrice).
  setupPrice: string | null;
  // Joined lego context (null on ordinary rows): the TO number (null until
  // converted to an order), the operation's sequence/heading, and article
  // facts printed on the förfrågan PDF.
  moOrderNumber: string | null;
  legoSequenceNo: number | null;
  legoDescription: string | null;
  legoShowNetWeight: boolean | null;
  articleWeight: string | null;
  articleSurfaceTreatment: string | null;
  articleColour: string | null;
  useArticleDrawing: boolean | null;
}

// One entry from GET /articles/:id/lego-operations — an MO or routing
// operation the article can be quoted against on a förfrågan row.
export interface LegoOperationOption {
  key: string; // "routing:<id>" | "mo:<id>"
  kind: "routing" | "mo";
  routingOperationId: string | null;
  moOperationId: string | null;
  label: string; // "Op 20 · Ytbehandling (beredning)" | "TO-1024 · Op 20 · Ytbehandling"
  supplierId: string | null;
  setupPrice: string | null;
  unitPrice: string | null;
}

export interface PurchaseOrderRow {
  id: string;
  purchaseOrderId: string;
  articleId: string;
  articleNumber: string;
  articleName: string;
  // Always stored in the article's base unit; unitCode/unitFactor say which
  // unit the row was entered in (factor null = base unit).
  quantityOrdered: string;
  quantityReceived: string;
  unitPrice: string;
  unitId: string | null;
  unitFactor: string | null;
  unitCode: string;
  // --- Lego (subcontract) row: buys an MO operation. ---
  // Null on ordinary rows. Receiving the row auto-reports the operation.
  moOperationId: string | null;
  // Ställpris — added ONCE to the row amount (qty × unitPrice + setupPrice).
  setupPrice: string | null;
  // The row's own Önskat leveransdatum; null = follows the order's.
  expectedDeliveryDate: string | null;
  // Joined lego context (null on ordinary rows): the TO number, the
  // operation's heading/sequence, whether the PDF shows net weight, and the
  // article's weight (kg per base unit).
  moOrderNumber: string | null;
  moOperationDescription: string | null;
  moOperationSequenceNo: number | null;
  moShowNetWeight: boolean | null;
  articleWeight: string | null;
  createdAt: string;
}

// One receipt on a purchase order (GET /purchase-orders/:id/receipts) —
// Inleveranser on the IO card. quantity is in the article's base unit (the
// row's unitFactor converts it); locationName is null on a lego row, which
// books no purchase stock, and moReportId links a lego receipt's TO report.
export interface PurchaseReceipt {
  id: string;
  purchaseOrderRowId: string;
  quantity: string;
  locationName: string | null;
  moReportId: string | null;
  createdAt: string;
  createdByName: string | null;
  undoneAt: string | null;
  undoneByName: string | null;
}

// Staffelsteg on a catalog row: an absolute price valid from `fromQuantity`
// (> 1 — quantity 1 is the row's own `price`). Base unit, catalog currency.
export interface ArticleSupplierPriceBreak {
  id: string;
  fromQuantity: number;
  price: number;
}

// One row in an article's supplier catalog (fliken Inköp) — the supplier's
// own article number, price and lead time, at most one huvudleverantör.
export interface ArticleSupplier {
  id: string;
  articleId: string;
  supplierId: string;
  supplierName: string;
  supplierArticleNumber: string | null;
  // Grundpriset — the price for quantity 1.
  price: string | null;
  currency: string;
  leadTimeDays: number | null;
  isPrimary: boolean;
  createdAt: string;
  priceBreaks: ArticleSupplierPriceBreak[];
}

// GET /supplier-price-quote — one supplier's catalog price for an article at a
// quantity (base unit), staffel-resolved. Used to prefill the IO row's à-pris.
export interface SupplierPriceQuote {
  articleNumber: string;
  price: { unitPrice: number; currency: string; fromQuantity: number; source: "break" | "base" } | null;
}

// Read-only per-article logs on the Inköp tab.
export interface GoodsReceiptLogEntry {
  id: string;
  date: string;
  orderNumber: string;
  supplierName: string;
  quantity: string;
  unitPrice: string;
  currency: string;
  locationName: string | null;
}

export interface PriceHistoryEntry {
  id: string;
  date: string;
  orderNumber: string;
  supplierName: string;
  unitPrice: string;
  currency: string;
  quantity: string;
}

// Fakturaunderlag: one received purchase order awaiting a supplier invoice.
// `id` is the purchase order id; `invoiceId` set once a non-cancelled
// supplier invoice is linked.
export interface PurchaseInvoiceBasisEntry {
  id: string;
  orderNumber: string;
  supplierId: string;
  supplierName: string;
  currency: string;
  status: PurchaseOrderStatus;
  receivedAt: string | null;
  receivedValue: string;
  invoiceId: string | null;
  invoiceRegistrationNumber: string | null;
}

// --- Leverantörsfaktura (AP) ---
// State machine: draft → approved → paid, cancellable from draft/approved.
export type SupplierInvoiceStatus = "draft" | "approved" | "paid" | "cancelled";

export const SUPPLIER_INVOICE_STATUS_PILL: Record<SupplierInvoiceStatus, { status: "running" | "delayed" | "stopped" | "done" | "draft"; label: string }> = {
  draft: { status: "draft", label: "Utkast" },
  approved: { status: "running", label: "Godkänd" },
  paid: { status: "done", label: "Betald" },
  cancelled: { status: "stopped", label: "Avbruten" },
};

export interface SupplierInvoice {
  id: string;
  // Internal LF- handle; invoiceNumber is the supplier's own fakturanummer.
  registrationNumber: string;
  invoiceNumber: string;
  supplierId: string;
  supplierName: string;
  purchaseOrderId: string | null;
  purchaseOrderNumber?: string | null;
  invoiceDate: string;
  dueDate: string | null;
  currency: string;
  status: SupplierInvoiceStatus;
  // Header totals entered from the physical invoice (authoritative).
  netAmount: string;
  vatAmount: string;
  grossAmount: string;
  note: string | null;
  // Automatkontering (B2): the L verification booked when the invoice was
  // approved. Null on drafts — and on everything approved before B2 existed.
  // verificationDisplayNumber is the joined "L-2026-12" label (series code,
  // fiscal year, verifikatnummer), assembled in the repository query.
  verificationId: string | null;
  verificationDisplayNumber: string | null;
  createdBy: string | null;
  createdAt: string;
  updatedAt: string;
  // Bankfiler: how the payment file identifies the payment to the supplier.
  paymentReferenceKind: "ocr" | "message" | null;
  paymentReference: string | null;
}

export interface SupplierInvoiceRow {
  id: string;
  supplierInvoiceId: string;
  articleId: string | null;
  articleNumber: string | null;
  articleName: string | null;
  // Optional link to the matched PO row; deviation fields are computed on read.
  purchaseOrderRowId: string | null;
  description: string;
  quantity: string;
  unitPrice: string;
  lineAmount: string;
  vatAmount: string;
  vatRate: string | null;
  poOrderNumber?: string | null;
  poQuantityOrdered?: string | null;
  poQuantityReceived?: string | null;
  poUnitPrice?: string | null;
  priceVariance?: string | null;
  quantityVariance?: string | null;
}

// openAmount is a number, not a numeric string (open-amounts.ts derives it
// server-side, same convention as OpenSupplierInvoiceRow's own openAmount
// above and the AR mirror InvoiceDetail's openAmount further down) —
// meaningless for draft/cancelled, see supplier-invoice.service.ts's
// getInvoice comment.
export interface SupplierInvoiceDetail extends SupplierInvoice {
  rows: SupplierInvoiceRow[];
  openAmount: number;
  payments: SupplierInvoicePaymentEntry[];
  files: SupplierInvoiceFile[];
  // Bankfiler: every payment-file row the invoice has been in, newest first.
  paymentBatches: { batchId: string; batchNumber: string; endToEndId: string; itemStatus: string }[];
}

// Underlag — the supplier's own invoice as PDF/scan. Räkenskapsinformation:
// removable only while the invoice is a draft. sha256 is taken at upload.
export interface SupplierInvoiceFile {
  id: string;
  supplierInvoiceId: string;
  filename: string;
  contentType: string;
  sizeBytes: number;
  sha256: string;
  uploadedBy: string | null;
  createdAt: string;
}

// --- Leverantörsreskontra (B4): öppna poster ---

// GET /open-supplier-invoices row — approved supplier invoices with a
// non-zero open amount (supplier-payment.repository.ts's listOpenInvoices).
// grossAmount/openAmount are computed server-side (open-amounts.ts) and come
// back as numbers, not numeric strings — same convention as the AR mirror,
// OpenInvoiceRow, further down this file. supplierName is the LIVE name
// (joined, no snapshot column on the invoice, unlike the AR side's
// customerName).
export interface OpenSupplierInvoiceRow {
  id: string;
  registrationNumber: string;
  invoiceNumber: string;
  supplierId: string;
  supplierName: string;
  invoiceDate: string;
  dueDate: string | null;
  grossAmount: number;
  openAmount: number;
  // Bankfiler: whether (and how) the supplier can be paid by file, and the
  // live batch the invoice is reserved in.
  supplierPaymentMethod: SupplierPaymentMethodValue | null;
  supplierIban: string | null;
  paymentBatch: { id: string; batchNumber: string; status: string } | null;
}

// GET /supplier-payments list row, and the header half of
// GET /supplier-payments/:id — supplier_payments columns plus the joined
// supplier name and the two verification display numbers
// (supplier-payment.repository.ts's paymentColumns). Same shape as the AR
// mirror PaymentHeader further down, with supplierId/supplierName instead of
// the customer pair. There is no status enum: "Makulerad" is derived from
// cancelledAt !== null. verificationDisplayNumber null = a pure kvittning
// (nothing booked, not a bokföringshändelse); cancellationDisplayNumber is
// the cancellation's own omföring — set only once the payment is cancelled
// AND it had booked one.
export interface SupplierPaymentHeader {
  id: string;
  paymentNumber: string;
  supplierId: string;
  paymentDate: string;
  bankAccountNumber: string;
  amount: string;
  note: string | null;
  verificationId: string | null;
  cancelledAt: string | null;
  cancelledBy: string | null;
  cancellationVerificationId: string | null;
  createdBy: string | null;
  createdAt: string;
  updatedAt: string;
  supplierName: string;
  verificationDisplayNumber: string | null;
  cancellationDisplayNumber: string | null;
}

// One settled open item — GET /supplier-payments/:id's rows
// (supplier-payment.repository.ts's listRows), in registration order.
// appliedAmount is the cash part, writeOffAmount the server-derived tolerance
// difference; both signed (negative on a supplier credit note's row).
// registrationNumber is the internal LF handle, invoiceNumber the supplier's
// own — both NOT NULL on supplier_invoices, unlike the AR mirror's
// invoiceNumber.
export interface SupplierPaymentRow {
  id: string;
  paymentId: string;
  supplierInvoiceId: string;
  appliedAmount: string;
  writeOffAmount: string;
  createdAt: string;
  registrationNumber: string;
  invoiceNumber: string;
  invoiceDueDate: string | null;
}

// GET /supplier-payments/:id — header plus its rows.
export interface SupplierPaymentDetail extends SupplierPaymentHeader {
  rows: SupplierPaymentRow[];
  // Bankfiler: the batch row a file payment confirms / the camt.054 entry
  // that confirmed it (both null for a manual payment).
  paymentBatchItem: { id: string; batchId: string; batchNumber: string; endToEndId: string } | null;
  bankFileEntry: { bankFileId: string; filename: string; dedupeKey: string } | null;
}

// One settlement row from the INVOICE's own point of view — mirrors
// supplier-invoice.repository.ts's listPaymentsForInvoice, in registration
// order. A cancelled payment (cancelledAt set) still appears — append-only,
// see supplier_payments' own comment — but no longer counts toward
// openAmount above. verificationId/verificationDisplayNumber are null for a
// pure kvittning (nothing booked, see PaymentHeader's own comment). Same
// shape as the AR mirror InvoicePaymentEntry further down.
export interface SupplierInvoicePaymentEntry {
  paymentId: string;
  paymentNumber: string;
  paymentDate: string;
  appliedAmount: string;
  writeOffAmount: string;
  cancelledAt: string | null;
  verificationId: string | null;
  verificationDisplayNumber: string | null;
}

export interface Customer extends PartnerCardFields {
  id: string;
  customerNumber: string;
  name: string;
  contactName: string | null;
  email: string | null;
  phone: string | null;
  // Besöksadressens land (ISO-2) — always set, defaults to "SE" server-side.
  country: string;
  // Fakturaadress + e-post för faktura (besöksadressen är PartnerCardFields.address).
  invoiceName: string | null;
  invoiceAddress: string | null;
  invoicePostalCode: string | null;
  invoiceCity: string | null;
  invoiceCountry: string | null;
  invoiceEmail: string | null;
  // C3 Kundpriser: assigned price list (chain level 3, fliken Priser). Not
  // settable on create — edited via PATCH like the terms FKs.
  priceListId: string | null;
  // Kundrabatt (%) — blanket discount, the price chain's last fallback (see
  // price-resolver.ts). A decimal column, so it arrives as a string like the
  // other money/percentage fields.
  discountPercent: string;
  // Vårt leverantörsnummer hos kunden (kundens motsvarighet till
  // Supplier.ourCustomerNumber) — nullable free-text field.
  ourSupplierNumber: string | null;
  // Samlingsfaktura: kunden faktureras via Försäljning →
  // Samlingsfakturering i stället for "Ny faktura" (spärrad server-side).
  collectiveInvoicing: boolean;
  // Frakt etapp 2: kundens förvalda fraktprodukt (nya försändelser ärver den).
  // The id is a column (always returned); the joined names are present on
  // the detail endpoint (GET :id) only, like the term/carrier names above.
  defaultFreightProductId: string | null;
  defaultFreightCarrierName?: string | null;
  defaultFreightProductName?: string | null;
  // Privatperson — styr etiketten Personnummer/Organisationsnummer på
  // Villkor & frakt.
  privatePerson: boolean;
  // Visa tilläggspriser — förval för konfigurerade raders pristillägg på
  // offert/orderbekräftelse (och vad fakturan följer).
  showConfigurationPrices: boolean;
  website: string | null;
  active: boolean;
  createdAt: string;
}

// Selectable delivery address on the customer card; at most one is default.
export interface CustomerDeliveryAddress {
  id: string;
  customerId: string;
  label: string;
  address: string;
  postalCode: string | null;
  city: string | null;
  // ISO-2 — always set, defaults to "SE" server-side.
  country: string;
  isDefault: boolean;
  createdAt: string;
}

// Prislistor (register) — staggered per-quantity pricing shared across
// customers via customers.priceListId (kundkortets prisflik, Task 12). List
// rows carry rowCount; the detail GET nests the price rows instead.
export interface PriceList {
  id: string;
  code: string;
  name: string;
  description: string | null;
  rowCount: number;
  createdAt: string;
}

// One quantity-break row (staffelrad) — prices are stored in the article's
// base unit, like sales_order_rows.unitPrice.
export interface PriceListRow {
  id: string;
  articleId: string;
  articleNumber: string;
  articleName: string;
  fromQuantity: string;
  unitPrice: string;
}

export interface PriceListWithRows {
  id: string;
  code: string;
  name: string;
  description: string | null;
  createdAt: string;
  rows: PriceListRow[];
}

// One customer-specific price/discount rule (kundkortets flik Priser) — a row
// from GET /customers/:id/prices (sales.repository.ts's listCustomerPrices).
// Exactly one of articleId/articleGroupId is set (article rules sort first,
// then group rules) and exactly one of unitPrice/discountPercent — the same
// two XORs customerPriceInputSchema validates server-side; the target never
// changes on an update (updateCustomerPriceSchema has no articleId/
// articleGroupId fields).
export interface CustomerPrice {
  id: string;
  articleId: string | null;
  articleNumber: string | null;
  articleName: string | null;
  articleGroupId: string | null;
  articleGroupName: string | null;
  fromQuantity: string;
  unitPrice: string | null;
  discountPercent: string | null;
}

export type SalesOrderStatus =
  | "quote"
  | "confirmed"
  | "in_production"
  | "delivered"
  | "invoiced"
  | "cancelled";

export const SALES_ORDER_STATUS_PILL: Record<SalesOrderStatus, { status: "running" | "delayed" | "stopped" | "done" | "draft"; label: string }> = {
  quote: { status: "draft", label: "Offert" },
  confirmed: { status: "running", label: "Bekräftad" },
  in_production: { status: "running", label: "Under tillverkning" },
  delivered: { status: "done", label: "Levererad" },
  invoiced: { status: "draft", label: "Fakturerad" },
  cancelled: { status: "stopped", label: "Avbruten" },
};

export interface SalesOrder extends DocumentTermsFields {
  id: string;
  orderNumber: string;
  customerId: string;
  customerName: string;
  status: SalesOrderStatus;
  expectedDeliveryDate: string | null;
  note: string | null;
  customerOrderNumber: string | null;
  customerReference: string | null;
  deliveryAddressId: string | null;
  // Joined from the selected delivery address (detail endpoint only).
  deliveryAddressLabel?: string | null;
  deliveryAddress?: string | null;
  deliveryPostalCode?: string | null;
  deliveryCity?: string | null;
  // Assigned when the order is invoiced (FA number series).
  invoiceNumber: string | null;
  invoicedAt: string | null;
  // Bumped on every content change (header/terms/rows).
  revision: number;
  createdBy: string | null;
  createdAt: string;
  updatedAt: string;
  // Only present when the list was fetched with withOpenRows=true — rows
  // still short of their ordered quantity (mirrors PurchaseOrder's
  // openRowCount).
  openRowCount?: number;
  // Detail-only: mirrors the customer's Samlingsfaktura flag — drives
  // SalesOrderDetail's "Fakturera" link to /forsaljning/samlingsfakturering.
  customerCollectiveInvoicing?: boolean;
}

// GET /collective-invoicing/candidates — customers flagged Samlingsfaktura
// with delivered, unbilled sales orders (candidates for a run).
export interface CollectiveInvoicingCandidate {
  customerId: string;
  customerNumber: string;
  name: string;
  orderCount: number;
  rowCount: number;
  shipmentCount: number;
  // SEK excl. VAT, plain number (not a decimal string like most money fields
  // elsewhere — matches the API response).
  netAmount: number;
}

// One row of POST /collective-invoicing/run's results array.
export interface CollectiveInvoicingResult {
  customerId: string;
  customerNumber: string | null;
  name: string | null;
  invoiceId: string | null;
  invoiceNumber: string | null;
  status: "draft" | "issued" | "skipped" | "failed";
  rowCount: number;
  error: string | null;
}

// E3: linked manufacturing order shown in the row's "I tillverkning" column
// (only non-cancelled orders — a cancelled TO frees the quantity back up).
export interface SalesOrderRowManufacturingOrder {
  id: string;
  orderNumber: string;
  status: string;
  quantity: string;
  // Inlevererat so far (delinleverans + Slutför).
  quantityReceived: string;
}

export interface SalesOrderRow {
  id: string;
  salesOrderId: string;
  articleId: string;
  articleNumber: string;
  articleName: string;
  // E3: only manufactured articles offer "Skapa tillverkningsorder".
  articleType: ArticleType;
  // Always stored in the article's base unit; unitCode/unitFactor say which
  // unit the row was entered in (factor null = base unit).
  quantityOrdered: string;
  quantityDelivered: string;
  unitPrice: string;
  // C3: row discount in percent (0-100), baked into lineAmount client-side —
  // never a separate ledger figure.
  discountPercent: string;
  unitId: string | null;
  unitFactor: string | null;
  unitCode: string;
  createdAt: string;
  // E3: derived "I tillverkning" coverage — the non-cancelled sum already in
  // production, and the orders themselves (for the linking column).
  quantityInProduction: number;
  manufacturingOrders: SalesOrderRowManufacturingOrder[];
  // Self cost per unit from the article's latest saved pre-calculation, for
  // the row's täckningsbidrag. null = no calculation exists — NOT a cost of
  // zero, and it must never be summed as one (see lib/margin.ts).
  selfCostPerUnit: number | null;
  // Konfigurator 4c: when a configured row's stored förkalkyl was calculated
  // (null for a plain row or a configured row without a calculation).
  selfCostCalculatedAt: string | null;
  // Konfigurator 4b: a to_order template's stored choices (null for a plain row),
  // and the template a variant row belongs to (null when not a variant).
  configuration: OrderRowConfiguration | null;
  variantTemplateArticleId: string | null;
}

// GET /articles/:id/self-cost — the same figure for an article that has no row
// yet, so a price can be judged while it is being set. null when the article
// has no saved pre-calculation.
export interface ArticleSelfCost {
  selfCostPerUnit: number;
  calculationId: string;
  calculatedAt: string;
  quantity: number;
}

// GET /price-quote?customerId=&articleId=&quantity=<base antal> — the same
// price chain resolvePrice uses (price-resolver.ts): customer article price
// → customer group rule → customer's price list → the article's base price.
// unitPrice is always in the article's BASE unit. price: null is a real
// answer ("nothing to charge beyond the base"/no chain match at all), not an
// error — order-row forms leave their price/discount fields untouched then,
// never zeroing a value the user might already have typed.
export interface PriceQuote {
  articleNumber: string;
  price: { unitPrice: number; discountPercent: number; source: string } | null;
}

// Leveranstillfälle (delivery occasion) — C2. One row per utleverans event;
// GET /sales-orders/:id/deliveries returns these newest first for the order
// card's "Följesedlar" history.
export interface SalesDelivery {
  id: string;
  deliveryNumber: string;
  deliveredAt: string;
  rowCount: number;
  // Frakt: the live (non-cancelled) shipment of this följesedel, if any.
  shipment: DeliveryShipmentInfo | null;
}

// --- Kundfaktura (customer invoice) — C1 ---
// State machine: draft → issued → paid; cancelled only from draft (post-issue
// corrections go through a credit note).
export type InvoiceStatus = "draft" | "issued" | "paid" | "cancelled";
export type InvoiceType = "invoice" | "credit";

export const INVOICE_STATUS_PILL: Record<InvoiceStatus, { status: "running" | "delayed" | "stopped" | "done" | "draft"; label: string }> = {
  draft: { status: "draft", label: "Utkast" },
  issued: { status: "running", label: "Utfärdad" },
  paid: { status: "done", label: "Betald" },
  cancelled: { status: "stopped", label: "Avbruten" },
};

export const INVOICE_TYPE_LABELS: Record<InvoiceType, string> = {
  invoice: "Faktura",
  credit: "Kreditfaktura",
};

// Shared header fields — mirrors getTableColumns(invoices) with
// customerName/paymentTermCode/paymentTermName resolved via COALESCE(frozen
// snapshot, live register) in both list() and findById() (invoice.repository.ts).
export interface InvoiceHeader {
  id: string;
  // Null while draft — assigned from the FA number series at issue.
  invoiceNumber: string | null;
  type: InvoiceType;
  creditedInvoiceId: string | null;
  customerId: string;
  paymentTermId: string | null;
  status: InvoiceStatus;
  currency: string;
  invoiceDate: string | null;
  dueDate: string | null;
  ocrNumber: string | null;
  customerName: string;
  invoiceAddress: string | null;
  invoicePostalCode: string | null;
  invoiceCity: string | null;
  orgNumber: string | null;
  vatNumber: string | null;
  paymentTermCode: string | null;
  paymentTermName: string | null;
  note: string | null;
  // Automatkontering (B2): the F verification booked when the invoice was
  // issued. Null on drafts — and on everything issued before B2 existed.
  // verificationDisplayNumber is the joined "F-2026-12" label (series code,
  // fiscal year, verifikatnummer), assembled in the repository query.
  verificationId: string | null;
  verificationDisplayNumber: string | null;
  issuedAt: string | null;
  paidAt: string | null;
  createdBy: string | null;
  createdAt: string;
  updatedAt: string;
}

// GET /invoices list row — netAmount/vatAmount are per-invoice SUMs over its
// rows' lineAmount/vatAmount, computed in the repository query. Always
// stored/returned positive; the `type` field communicates credit, never the
// amount sign.
export interface Invoice extends InvoiceHeader {
  netAmount: string;
  vatAmount: string;
}

export interface InvoiceRow {
  id: string;
  invoiceId: string;
  articleId: string | null;
  // The delfakturering link: which sales order row this line settles (null
  // = a free/manual row).
  salesOrderRowId: string | null;
  // Frakt etapp 2: the booked shipment this row bills (quantity stays 1) —
  // null on every non-freight row, always present in the API's row views.
  shipmentId: string | null;
  shipmentNumber: string | null;
  description: string;
  quantity: string;
  unitPrice: string;
  unitId: string | null;
  unitFactor: string | null;
  // The row's display unit code — the linked/entered unit falling back to
  // the article's base unit, null for a free row (no article).
  unitCode: string | null;
  vatRate: string;
  lineAmount: string;
  vatAmount: string;
  createdAt: string;
  articleNumber: string | null;
  articleName: string | null;
  salesOrderNumber: string | null;
  // Konfigurator 4b: copy of the order row's configuration (null for a
  // free/plain row), printed as choice lines on the invoice PDF.
  configuration: OrderRowConfiguration | null;
}

// Kundreskontra (B3): one settlement row from the invoice's own point of
// view — mirrors invoice.repository.ts's listPaymentsForInvoice, in
// registration order. A cancelled payment (cancelledAt set) still appears —
// append-only, see customer_payments' own comment — but no longer counts
// toward openAmount below. verificationId/verificationDisplayNumber are null
// for a pure kvittning (nothing booked, see PaymentHeader's own comment).
export interface InvoicePaymentEntry {
  paymentId: string;
  paymentNumber: string;
  paymentDate: string;
  appliedAmount: string;
  writeOffAmount: string;
  cancelledAt: string | null;
  verificationId: string | null;
  verificationDisplayNumber: string | null;
}

// Kundreskontra (B3): the invoice's own reminder history — mirrors
// invoice.repository.ts's listRemindersForInvoice, level order.
// feeVerificationId/feeVerificationDisplayNumber are null for a fee-free
// reminder.
export interface InvoiceReminderEntry {
  id: string;
  level: number;
  fee: string;
  sentAt: string;
  feeVerificationId: string | null;
  feeVerificationDisplayNumber: string | null;
  // The archived PDF exactly as emailed (invoice_documents) — null for
  // reminders sent before the archive existed.
  documentId: string | null;
}

// GET /invoices/:id — header plus its rows plus the B3 kundreskontra history.
// No netAmount/vatAmount at the header level (unlike the list row) — sum the
// rows client-side when needed. openAmount is a number, not a numeric string
// (open-amounts.ts derives it server-side, same convention as
// OpenInvoiceRow's own openAmount) — meaningless for draft/cancelled, see
// invoice.service.ts's getInvoice comment.
export interface InvoiceDetail extends InvoiceHeader {
  rows: InvoiceRow[];
  openAmount: number;
  payments: InvoicePaymentEntry[];
  reminders: InvoiceReminderEntry[];
  // Reverse of creditedInvoiceId — every non-cancelled credit note that
  // targets this invoice. invoiceNumber is null for a still-draft credit;
  // the card labels that "Utkast" rather than hiding the link.
  creditedBy: { id: string; invoiceNumber: string | null }[];
}

export interface InvoiceableOrderRow {
  salesOrderRowId: string;
  articleId: string;
  articleNumber: string;
  articleName: string;
  unitPrice: string;
  // C3: the order row's discount, carried into the invoice draft's prefill.
  discountPercent: string;
  unitId: string | null;
  unitFactor: string | null;
  unitCode: string;
  vatRate: string;
  // Delivered minus already invoiced (drafts included) — the max billable
  // quantity for this row right now.
  rest: number;
  // Konfigurator 4b: the order row's configuration (null for a plain row).
  configuration: OrderRowConfiguration | null;
}

// GET /invoiceable-shipments?customerId= — booked, not-yet-invoiced
// shipments (freight) for the invoice dialog's Frakt group.
export interface InvoiceableShipment {
  shipmentId: string;
  shipmentNumber: string;
  customerId: string;
  carrierName: string | null;
  productName: string | null;
  customerPrice: string;
  bookedAt: string | null;
  deliveryNumbers: string[];
  articleId: string;
  articleNumber: string;
  articleName: string;
  vatRate: string;
  description: string;
}

// GET /invoiceable-orders?customerId= — delivered/in_production/invoiced
// orders with rows that still have an un-invoiced delivered quantity,
// grouped per order. Draft-invoice basis for the create dialog.
export interface InvoiceableOrder {
  orderId: string;
  orderNumber: string;
  rows: InvoiceableOrderRow[];
}

// --- Kundreskontra (B3): öppna poster & betalningar ---

// GET /open-invoices row and GET /open-invoices/by-ocr/:ocr — issued
// invoices with a non-zero open amount (payment.repository.ts's
// listOpenInvoices/findOpenByOcr). grossAmount/openAmount are computed
// server-side (open-amounts.ts) and come back as numbers, not numeric
// strings — a credit note's amounts are negative. reminderCount is a plain
// COUNT over invoice_reminders (0 for an invoice never reminded, and always
// 0 for a credit note — a reminder can only be sent for a positive open
// amount); reminderFeeCharged is whether any of those reminders EVER charged
// a fee, not whether it's still unpaid (that's already folded into
// openAmount, see open-amounts.ts).
export interface OpenInvoiceRow {
  id: string;
  invoiceNumber: string | null;
  type: InvoiceType;
  customerId: string;
  customerName: string;
  invoiceDate: string | null;
  dueDate: string | null;
  ocrNumber: string | null;
  grossAmount: number;
  openAmount: number;
  reminderCount: number;
  reminderFeeCharged: boolean;
}

// GET /payments list row, and the header half of GET /payments/:id —
// customer_payments columns plus the joined customer name and the two
// verification display numbers (payment.repository.ts's paymentColumns).
// There is no status enum: "Makulerad" is derived from cancelledAt !== null.
// verificationDisplayNumber null = a pure kvittning (nothing booked, not a
// bokföringshändelse); cancellationDisplayNumber is the cancellation's own
// omföring — set only once the payment is cancelled AND it had booked one.
export interface PaymentHeader {
  id: string;
  paymentNumber: string;
  customerId: string;
  paymentDate: string;
  bankAccountNumber: string;
  amount: string;
  note: string | null;
  verificationId: string | null;
  cancelledAt: string | null;
  cancelledBy: string | null;
  cancellationVerificationId: string | null;
  createdBy: string | null;
  createdAt: string;
  updatedAt: string;
  customerName: string;
  verificationDisplayNumber: string | null;
  cancellationDisplayNumber: string | null;
}

// One settled open item — GET /payments/:id's rows (payment.repository.ts's
// listRows), in registration order. appliedAmount is the cash part,
// writeOffAmount the server-derived tolerance difference; both signed
// (negative on a credit note's row).
export interface PaymentRow {
  id: string;
  paymentId: string;
  invoiceId: string;
  appliedAmount: string;
  writeOffAmount: string;
  createdAt: string;
  invoiceNumber: string | null;
  invoiceType: InvoiceType;
  invoiceDueDate: string | null;
}

// GET /payments/:id — header plus its rows.
export interface PaymentDetail extends PaymentHeader {
  rows: PaymentRow[];
  // Bankfiler: the camt.054 entry this payment was booked from.
  bankFileEntry: { bankFileId: string; filename: string; dedupeKey: string } | null;
}

// GET /account-options — active accounts' number+name only (a deliberate
// plain-auth exception carved out for the betalkonto dropdown, see
// economy.routes.ts's own comment on the endpoint). Not the full Account
// shape: no id/active, since nothing here lets a caller look an account up
// or change it.
export interface AccountOption {
  number: string;
  name: string;
}

// Work center = resurs in the UI.
export interface WorkCenter {
  id: string;
  // Resource number: exactly 3 digits, freely chosen — grouping happens via
  // the production group, not the digits. Legoresurser (type "subcontract")
  // share the same series.
  code: string;
  name: string;
  type: "machine" | "personnel" | "subcontract";
  productionGroupId: string | null;
  // Joined in by the list endpoint (null when ungrouped).
  productionGroupCode: string | null;
  productionGroupName: string | null;
  hourlyRate: string;
  overheadPercent: string;
  active: boolean;
  // E2 Beläggning: the resource's weekly opening hours (null = no schedule,
  // so the capacity matrix can't compute availableHours for it) and a
  // multiplier for parallel capacity (e.g. two identical machines = 2).
  weekScheduleId: string | null;
  weekScheduleCode: string | null;
  weekScheduleName: string | null;
  capacityFactor: string;
  // Legoresurs only: the resource's default supplier, prefilled on new lego
  // operations in the beredning (supplierName joined by the list endpoint).
  supplierId: string | null;
  supplierName: string | null;
  // Monitor G5 import fields (Produktionsgruppslista Kostnader/Lista): a
  // second calc rate and whether the rate(s) apply to setup/run time, plus
  // the Lista file's default setup time and operation name used to prefill
  // new routing rows for the resource. All null until imported/set.
  defaultSetupTime: string | null;
  defaultOperationName: string | null;
  rateAppliesToSetup: boolean | null;
  rateAppliesToRun: boolean | null;
  calcRate1: string | null;
  // Legoresurs only, from the Lego file: lead time to perform the work,
  // queue time before it starts, and lead time to place the order.
  leadTimeDays: string | null;
  queueTimeDays: string | null;
  orderLeadTimeDays: string | null;
}

export const WORK_CENTER_TYPE_LABELS: Record<WorkCenter["type"], string> = {
  machine: "Maskin",
  personnel: "Personal",
  subcontract: "Lego",
};

export interface RoutingOperation {
  id: string;
  articleId: string;
  sequenceNo: number;
  // "Beskrivning" — what the step IS (Monitor's "Operationens benämning").
  // Every surface falls back to workCenterName when it is null.
  description: string | null;
  workCenterId: string;
  workCenterName: string;
  workCenterCode: string;
  setupTime: string;
  runTimePerUnit: string;
  // Display preference for runTimePerUnit — always stored/returned in
  // minutes per unit regardless of this value; conversion happens at the
  // edges (OperationModal, BeredningView) via lib/units.ts.
  timeUnit: "minutes_per_unit" | "units_per_hour";
  // "Kalkyl" — priced into the pre-calculation but skipped at release, so it
  // never reaches the MO.
  costingOnly: boolean;
  // "Kommentar" — free text on the operation (Monitor's "Instruktion"),
  // printed under the operation row on the work card when printOnWorkCard.
  comment: string | null;
  printOnWorkCard: boolean;
  // "Packinstruktion" — how the articles are packed ahead of the next
  // operation/shipment. Always printed under the operation row on the work
  // card when set, independent of printOnWorkCard.
  packingInstructions: string | null;
  // Joined in by the list endpoint — "subcontract" marks a lego operation.
  workCenterType: "machine" | "personnel" | "subcontract";
  // --- Lego (subcontract) fields — null/defaults on ordinary operations. ---
  subcontractSupplierId: string | null;
  subcontractSupplierName: string | null;
  setupPrice: string | null;
  unitPrice: string | null;
  showNetWeight: boolean;
  useArticleDrawing: boolean;
  // Whether a drawing is uploaded on the operation (routing_operation_files).
  hasFile: boolean;
}

export type ManufacturingOrderStatus =
  | "planned"
  | "released"
  | "in_progress"
  | "done"
  | "closed"
  | "cancelled";

export const MANUFACTURING_ORDER_STATUS_PILL: Record<ManufacturingOrderStatus, { status: "running" | "delayed" | "stopped" | "done" | "draft"; label: string }> = {
  planned: { status: "draft", label: "Planerad" },
  released: { status: "running", label: "Frisläppt" },
  in_progress: { status: "running", label: "Pågår" },
  done: { status: "done", label: "Klar" },
  closed: { status: "draft", label: "Stängd" },
  cancelled: { status: "stopped", label: "Makulerad" },
};

export interface ManufacturingOrder {
  id: string;
  orderNumber: string;
  articleId: string;
  articleNumber: string;
  articleName: string;
  quantity: string;
  // Inlevererat — received into stock so far (delinleverans from the last
  // operation, plus Slutför).
  quantityReceived: string;
  status: ManufacturingOrderStatus;
  note: string | null;
  createdBy: string | null;
  createdAt: string;
  updatedAt: string;
  salesOrder: { id: string; orderNumber: string; customerName: string } | null;
  // E2 Beläggning: planned completion date, "YYYY-MM-DD" — drives the
  // capacity matrix's week bucketing (overdue orders roll into the current
  // week) and is editable via PATCH while the order is open.
  dueDate: string | null;
  // Konfigurator 4c: the choices of a made-to-order (beställningsvara) TO; null for a plain TO.
  configuration: ManufacturingOrderConfiguration | null;
  // Only present when the list was fetched with ?withOperations=true
  // (operation summaries per order, e.g. for integrations).
  operations?: MOOperationSummary[];
  // Only on the create response (a new TO is released at creation): the
  // same shortage warnings Släpp returns.
  releaseWarnings?: string[];
}

// GET /manufacturing-orders?withOperations=true — a slim per-order view of
// the operations (sequence, status, work center, production group).
export interface MOOperationSummary {
  id: string;
  sequenceNo: number;
  status: MOOperationStatus;
  description: string | null;
  workCenterCode: string;
  workCenterName: string;
  workCenterType: "machine" | "personnel" | "subcontract";
  productionGroupCode: string | null;
  productionGroupName: string | null;
}

// E2 Beläggning (capacity load matrix) — GET /api/v1/planning/capacity.
// Everything here is derived server-side from released/in-progress
// manufacturing orders' remaining operation time; the web side only renders
// it, no client-side aggregation.
export interface CapacityCellOrder {
  manufacturingOrderId: string;
  orderNumber: string;
  articleNumber: string;
  articleName: string;
  sequenceNo: number;
  dueDate: string | null;
  overdue: boolean;
  remainingHours: number;
}

export interface CapacityCell {
  loadHours: number;
  // null when the resource has no week schedule (hasSchedule = false on the
  // owning CapacityResourceRow) — no capacity figure to compare against.
  availableHours: number | null;
  loadPercent: number | null;
  orders: CapacityCellOrder[];
}

export interface CapacityResourceRow {
  workCenterId: string;
  code: string;
  name: string;
  type: "machine" | "personnel";
  active: boolean;
  capacityFactor: number;
  hasSchedule: boolean;
  // Index-aligned with CapacityResult.weeks.
  weeks: CapacityCell[];
  later: CapacityCell;
  undated: CapacityCell;
}

export interface CapacityGroupBlock {
  // null = "Ogrupperade resurser".
  productionGroupId: string | null;
  code: string | null;
  name: string;
  resources: CapacityResourceRow[];
  weekTotals: CapacityCell[];
  laterTotal: CapacityCell;
  undatedTotal: CapacityCell;
}

export interface CapacityWeek {
  isoYear: number;
  isoWeek: number;
  monday: string;
  sunday: string;
}

export interface CapacityResult {
  weeks: CapacityWeek[];
  groups: CapacityGroupBlock[];
}

export interface MOMaterialConsumption {
  // Which operation draws this material; null = drawn at final reporting.
  moOperationId: string | null;
  id: string;
  manufacturingOrderId: string;
  componentArticleId: string;
  componentArticleNumber: string;
  componentName: string;
  // Always stored in the component's base unit; unitCode/unitFactor say
  // which unit the BOM row was entered in (factor null = base unit).
  quantityPlanned: string;
  quantityConsumed: string;
  unitId: string | null;
  unitFactor: string | null;
  unitCode: string;
  createdAt: string;
}

export type MOOperationStatus = "pending" | "done";

export interface MOOperation {
  id: string;
  manufacturingOrderId: string;
  sequenceNo: number;
  // Snapshot of the routing operation's Beskrivning, taken at release.
  description: string | null;
  workCenterId: string;
  workCenterName: string;
  workCenterCode: string;
  setupTime: string;
  runTimePerUnit: string;
  // Snapshot of the routing operation's display preference at release — see
  // RoutingOperation.timeUnit above.
  timeUnit: "minutes_per_unit" | "units_per_hour";
  status: MOOperationStatus;
  actualTime: string | null;
  // Accumulated OK quantity from stamp-out/completion reports (may exceed
  // the order quantity — over-reporting draws extra material).
  quantityCompleted: string | null;
  // Accumulated scrapped quantity — scrap also consumes linked material.
  quantityScrapped: string;
  // Snapshot of the routing operation's Kommentar, taken at release.
  comment: string | null;
  printOnWorkCard: boolean;
  // Snapshot of the routing operation's Packinstruktion, taken at release —
  // always shown regardless of printOnWorkCard.
  packingInstructions: string | null;
  // "subcontract" marks a lego operation: hidden in the stamp terminal
  // (bought via IO, not stamped), badged on the MO card.
  workCenterType: "machine" | "personnel" | "subcontract";
  // Lego snapshot from release (null/false on ordinary operations).
  subcontractSupplierId: string | null;
  subcontractSupplierName: string | null;
  setupPrice: string | null;
  unitPrice: string | null;
  showNetWeight: boolean;
  createdAt: string;
}

// One scrap report on an operation (GET /manufacturing-orders/:id/scrap).
export interface ScrapEntry {
  id: string;
  moOperationId: string;
  sequenceNo: number;
  workCenterName: string;
  quantity: string;
  reason: string;
  employeeName: string | null;
  createdAt: string;
}

// Rapporteringslogg on the TO card — one row per reporting event; an undone
// row stays, marked with when and by whom (GET /manufacturing-orders/:id/reports).
export interface MOReport {
  id: string;
  kind: "operation" | "completion" | "material";
  source: "terminal" | "card" | "purchase_receipt" | "migration" | "auto_close";
  moOperationId: string | null;
  sequenceNo: number | null;
  workCenterName: string | null;
  quantityOk: string;
  quantityScrapped: string;
  quantityReceived: string;
  completedOrder: boolean;
  // The stamp's hours — null when there was no stamp or its time is gone.
  hours: string | null;
  employeeName: string | null;
  userName: string | null;
  purchaseOrderNumber: string | null;
  createdAt: string;
  undoneAt: string | null;
  undoneByName: string | null;
  materials: { articleNumber: string; quantity: string }[];
}

export type EmploymentType = "hourly" | "monthly";

export const EMPLOYMENT_TYPE_LABELS: Record<EmploymentType, string> = {
  hourly: "Timlön",
  monthly: "Månadslön",
};

export type OvertimeCompensation = "payout" | "comp";

export const OVERTIME_COMPENSATION_LABELS: Record<OvertimeCompensation, string> = {
  payout: "Utbetalning",
  comp: "Komptid",
};

// GET /employees/directory — the shop-floor view of the personnel register
// (no personnummer/wage/address). The full Employee is Personal-only.
export interface EmployeeDirectoryEntry {
  id: string;
  employeeNumber: string;
  name: string;
  active: boolean;
  defaultWorkCenterIds: string[];
}

export interface Employee {
  id: string;
  employeeNumber: string;
  name: string;
  active: boolean;
  // Förvalda stationer (work centers preselected in the terminal); not returned by
  // GET /employees or POST /employees, hence optional.
  defaultWorkCenterIds?: string[];
  // Kontaktuppgifter
  phone: string | null;
  email: string | null;
  address: string | null;
  postalCode: string | null;
  city: string | null;
  // Anställningsdata
  personalIdentityNumber: string | null; // personnummer
  employedFrom: string | null;
  employedTo: string | null;
  // Löneuppgifter — wage is timlön or månadslön depending on employmentType.
  employmentType: EmploymentType | null;
  wage: string | null;
  weeklyHours: string | null;
  // How overtime is compensated by default; per-day overrides are set in the
  // Attestering day detail.
  overtimeCompensation: OvertimeCompensation;
  // Standardveckoschema — overridable per week/day via the employee calendar.
  defaultWeekScheduleId: string | null;
  // ATF: bank = tidbank, weekly = veckouttag. minutesPerWeek null = follow
  // the system setting; startDate null = no accrual.
  atfMode: AtfMode;
  atfMinutesPerWeek: number | null;
  atfStartDate: string | null;
  createdAt: string;
}

// --- ATF (arbetstidsförkortning) ---

export type AtfMode = "bank" | "weekly";

export const ATF_MODE_LABELS: Record<AtfMode, string> = {
  bank: "Tidbank",
  weekly: "Veckouttag",
};

export type AtfTransactionType = "withdrawal" | "adjustment";

export const ATF_TRANSACTION_TYPE_LABELS: Record<AtfTransactionType, string> = {
  withdrawal: "Uttag",
  adjustment: "Justering",
};

export interface AtfTransaction {
  id: string;
  date: string;
  type: AtfTransactionType;
  // withdrawal: positive minutes taken out; adjustment: signed minutes.
  minutes: number;
  note: string | null;
  createdAt: string;
}

// Balance = derived accrual (completed weeks × rate) + adjustments − withdrawals.
export interface AtfStatus {
  mode: AtfMode;
  effectiveMinutesPerWeek: number;
  source: "employee" | "system";
  startDate: string | null;
  accruedMinutes: number;
  withdrawnMinutes: number;
  adjustedMinutes: number;
  balanceMinutes: number;
  transactions: AtfTransaction[];
}

// --- Scheman & kalender ---

// Rast (unpaid — deducted from working time) vs paus (paid — included).
export type ScheduleBreakType = "unpaid" | "paid";

export const SCHEDULE_BREAK_TYPE_LABELS: Record<ScheduleBreakType, string> = {
  unpaid: "Rast",
  paid: "Paus",
};

export interface ScheduleBreak {
  type: ScheduleBreakType;
  startTime: string; // "HH:MM"
  endTime: string;
}

export interface DaySchedule {
  id: string;
  code: string;
  name: string;
  startTime: string; // "HH:MM"
  endTime: string;
  active: boolean;
  breaks: ScheduleBreak[];
  createdAt: string;
}

// ISO weekday: 1 = måndag … 7 = söndag. Missing weekday = ledig.
export interface WeekScheduleDay {
  weekday: number;
  dayScheduleId: string;
  dayScheduleCode: string;
  dayScheduleName: string;
}

export interface WeekSchedule {
  id: string;
  code: string;
  name: string;
  active: boolean;
  days: WeekScheduleDay[];
  createdAt: string;
}

// dayScheduleId null = helt ledig (röd dag), set = t.ex. halvdagsschema.
export interface Holiday {
  id: string;
  date: string;
  name: string;
  dayScheduleId: string | null;
  dayScheduleCode: string | null;
  dayScheduleName: string | null;
}

export interface EmployeeWeekOverride {
  id: string;
  isoYear: number;
  isoWeek: number;
  weekScheduleId: string;
  weekScheduleCode: string;
  weekScheduleName: string;
}

// dayScheduleId null = ledig.
export interface EmployeeDayOverride {
  id: string;
  date: string;
  dayScheduleId: string | null;
  dayScheduleCode: string | null;
  dayScheduleName: string | null;
}

export interface EmployeeScheduleOverrides {
  weekOverrides: EmployeeWeekOverride[];
  dayOverrides: EmployeeDayOverride[];
}

// One resolved calendar day: which day schedule actually applies and why.
// GET /articles/:id/due-date-suggestion — färdigdatumsförslag for a new TO:
// one working day before the article's first uncovered firm demand (or the
// linked KO row's delivery date), today at the earliest.
export interface DueDateSuggestion {
  dueDate: string;
  demandDate: string;
  source: "sales_order_row" | "shortage";
  documentType: "sales_order" | "purchase_order" | "manufacturing_order" | null;
  documentId: string | null;
  documentNumber: string | null; // null = negative stock, no document
  clampedToToday: boolean;
}

export interface ResolvedCalendarDay {
  date: string;
  weekday: number;
  source: "day-override" | "holiday" | "week-override" | "standard" | null;
  holidayName?: string;
  daySchedule: {
    id: string;
    code: string;
    name: string;
    startTime: string;
    endTime: string;
    netMinutes: number;
    breaks: { type: "unpaid" | "paid"; startTime: string; endTime: string }[];
  } | null;
}

export interface ProductionGroup {
  id: string;
  code: string;
  name: string;
  description: string | null;
  active: boolean;
  createdAt: string;
}

// List view: count comes from the API's subquery over the resources' FK.
export interface ProductionGroupListItem extends ProductionGroup {
  workCenterCount: number;
}

export interface ProductionGroupDetail extends ProductionGroup {
  workCenters: { id: string; code: string; name: string; type: "machine" | "personnel" }[];
}

// Närvarostämpling (kom/gå) — joined view for the terminal.
export interface AttendanceSession {
  id: string;
  employeeId: string;
  employeeName: string;
  employeeNumber: string;
  startedAt: string;
  stoppedAt: string | null;
}

export interface TimeReport {
  id: string;
  employeeId: string;
  employeeName: string;
  moOperationId: string;
  manufacturingOrderId: string;
  manufacturingOrderNumber: string;
  operationSequenceNo: number;
  workCenterName: string;
  date: string;
  hours: string;
  note: string | null;
  createdAt: string;
  // terminal = materialized by a stamp-out at the terminal, manual = entered by hand
  source: "terminal" | "manual";
}

// Stämpling — joined view of a stamp_sessions row for the terminal UI.
export interface StampSession {
  id: string;
  employeeId: string;
  employeeName: string;
  employeeNumber: string;
  moOperationId: string;
  manufacturingOrderId: string;
  manufacturingOrderNumber: string;
  operationSequenceNo: number;
  workCenterName: string;
  articleName: string;
  startedAt: string;
  stoppedAt: string | null;
  // Going home pauses open work: pausedAt set while away, pausedSeconds
  // accumulates over pauses. Paused time is excluded from reported hours.
  pausedAt: string | null;
  pausedSeconds: string;
  timeReportId: string | null;
  // Shop-floor packing instructions for the current operation, snapshotted
  // at release — shown in the terminal's stamp-out view when set.
  packingInstructions: string | null;
  // The MO's planned quantity and what the operation has accumulated so far
  // (OK may be null before the first report) — the stamp-out view shows
  // Planerat / Klart / Kvar from these.
  orderQuantity: string;
  operationQuantityCompleted: string | null;
  operationQuantityScrapped: string;
  // Admin/supervisor only (frånvaro is health data): the employee has
  // absence registered today. Absent from the payload for everyone else.
  absentToday?: boolean;
}

export interface SystemSettings {
  allowMultipleStamps: boolean;
  // Print active article/drawing revisions per row on external documents.
  showRevisionsOnDocuments: boolean;
  // Print the order's own revision after the document number
  // ("Inköpsorder IO2500123 / 2") on offert/orderbekräftelse/inköpsorder.
  showOrderRevisionOnDocuments: boolean;
  // Company-wide ATF accrual in minutes per completed work week (0 = off);
  // individual employees can override it on the personalkort.
  atfMinutesPerWeek: number;
  // Daily overtime grace period in minutes (löneunderlag) — worked time past
  // schedule must exceed this before it counts as overtime.
  payrollOvertimeThresholdMinutes: number;
  // PAXml löneart codes used by the payroll export — must match the payroll
  // system's own löneartstabell. Never empty: the API decodes an unset or
  // blanked key back to its Monitor-like default.
  paxmlCodeWorked: string;
  paxmlCodeOvertime: string;
  paxmlCodeOvertimeOffSchedule: string;
  paxmlCodeOvertimeComp: string;
  paxmlCodeOvertimeOffScheduleComp: string;
  paxmlCodeAtf: string;
  // External SMTP server for document emails. The password is write-only:
  // the API only reports whether one is stored.
  smtpHost: string;
  smtpPort: number;
  smtpSecure: boolean;
  smtpUser: string;
  smtpPasswordSet: boolean;
  smtpFromName: string;
  smtpFromEmail: string;
  // Costing (System → Kalkyler). Where a component's unit cost is read from,
  // and the markups that build the sales price. All default to 0 / "standard",
  // which leaves the calculation as it was.
  costingMaterialSource: CostingMaterialSource;
  // Stafflade leverantörspriser in the calculation (only with source
  // "supplier"): "base" = grundpriset, "tiered" = the step for the quantity.
  costingSupplierPriceTier: CostingSupplierPriceTier;
  // Materialbrist vid rapportering: none = ingen kontroll, warn = fråga först, block = spärr.
  manufacturingMaterialShortage: "none" | "warn" | "block";
  supplierDeliveryDayMode: DeliveryDayMode;
  supplierTransitDays: number;
  customerDeliveryDayMode: DeliveryDayMode;
  customerTransitDays: number;
  costingMoPercent: number;
  costingLoPercent: number;
  costingAffoPercent: number;
  costingGeneralMarkupPercent: number;
  // Tillåten överleverans på inköpsorder, percent of the row's ordered
  // quantity. null = no limit, 0 (the default) = never past the ordered
  // quantity.
  purchaseOverReceiptPercent: number | null;
  // Automatkontering (B2): standardkonton for the 14 posting roles, always a
  // 4-digit account number — never null/empty on GET (posting-settings.ts's
  // codeSetting falls back to the BAS default when unset). PATCH accepts ""
  // to reset a field back to its default.
  postingAccountsReceivable: string;
  postingVatOut25: string;
  postingVatOut12: string;
  postingVatOut6: string;
  postingRevenue25: string;
  postingRevenue12: string;
  postingRevenue6: string;
  postingRevenue0: string;
  postingAccountsPayable: string;
  postingVatIn: string;
  postingDefaultCost: string;
  // Kundreskontra (B3): bank/betalkonto, reminder-fee account, and the
  // öres-/kronutjämning (payment write-off) account — same 4-digit/""-to-reset
  // convention as the accounts above.
  postingBank: string;
  postingReminderFeeAccount: string;
  postingPaymentWriteOff: string;
  // Momsrapport (B5): redovisningskonto för moms — the momsomföring's
  // counter account.
  postingVatSettlement: string;
  // Årsbokslut (steg 2): lager och lagerförändring.
  postingInventory: string;
  postingInventoryChange: string;
  // How much a payment may miss the invoice's remaining amount by and still
  // count as fully paid (kr), and the fee charged per payment reminder (kr).
  // Unlike the account codes, there is no reset-to-default — always a number.
  paymentTolerance: number;
  reminderFee: number;
}

// "actual" = the moving average at the consumption date, derived from the stock
// log; it applies to the post-calculation only.
export type CostingMaterialSource = "supplier" | "standard" | "actual";
export type CostingSupplierPriceTier = "base" | "tiered";

// Files attached to an article (ritningar): PDF/JPEG/PNG.
export interface ArticleFile {
  id: string;
  articleId: string;
  filename: string;
  contentType: string;
  sizeBytes: number;
  createdAt: string;
}

// Artikelrevisioner & ritningar (fliken Revisioner) — at most one active
// revision per article resp. drawing number.
export interface ArticleRevision {
  id: string;
  articleId: string;
  revision: string;
  comment: string | null;
  isActive: boolean;
  createdAt: string;
}

export interface ArticleDrawingRevision {
  id: string;
  drawingId: string;
  revision: string;
  comment: string | null;
  isActive: boolean;
  createdAt: string;
}

export interface ArticleDrawing {
  id: string;
  articleId: string;
  drawingNumber: string;
  createdAt: string;
  revisions: ArticleDrawingRevision[];
}

// --- Outbound email (mail module) ---

export type EmailDocumentType =
  | "inquiry"
  | "purchase_order"
  | "quote"
  | "order_confirmation"
  | "invoice"
  // Betalningspåminnelse (B3) — logged against the invoice's own id.
  | "payment_reminder"
  | "test";
export type EmailStatus = "sent" | "failed";

export const EMAIL_DOCUMENT_TYPE_LABELS: Record<EmailDocumentType, string> = {
  inquiry: "Förfrågan",
  purchase_order: "Inköpsorder",
  quote: "Offert",
  order_confirmation: "Orderbekräftelse",
  invoice: "Faktura",
  payment_reminder: "Betalningspåminnelse",
  test: "Testmejl",
};

export const EMAIL_STATUS_PILL: Record<EmailStatus, { status: "running" | "delayed" | "stopped" | "done" | "draft"; label: string }> = {
  sent: { status: "done", label: "Skickat" },
  failed: { status: "stopped", label: "Misslyckat" },
};

// Which card the Dokument column should link to. Equals documentType for
// every type except "invoice", where old (pre-C1) rows point at a sales
// order id instead of a real invoice — see the API's mail.repository.ts.
export type EmailLinkKind = EmailDocumentType | "sales_order";

export interface EmailLogEntry {
  id: string;
  documentType: EmailDocumentType;
  documentId: string | null;
  linkKind: EmailLinkKind;
  recipient: string;
  subject: string;
  message: string;
  status: EmailStatus;
  error: string | null;
  createdAt: string;
  // Konfigurator 4b: Visa tilläggspriser as sent (quote/order confirmation);
  // null = not applicable to the document type.
  showConfigurationPrices: boolean | null;
}

export interface ApiClient {
  id: string;
  name: string;
  active: boolean;
  createdAt: string;
  // Behörigheter per klient (4.9).
  scopes: import("./apiClientScopes").ApiClientScope[];
  customerId: string | null;
  customer: { id: string; customerNumber: string; name: string } | null;
}

export interface CompanyInfo {
  id: string;
  name: string;
  orgNumber: string | null;
  address: string | null;
  postalCode: string | null;
  city: string | null;
  phone: string | null;
  email: string | null;
  website: string | null;
  // Payment/registration details printed in the footer of outgoing documents.
  bankgiro: string | null;
  plusgiro: string | null;
  bankName: string | null;
  iban: string | null;
  bic: string | null;
  vatNumber: string | null;
  companySeat: string | null;
  fSkatt: boolean;
  hasLogo: boolean;
  updatedAt: string;
}

// The company's own customer number at a carrier (Företagsinformation →
// Speditörer). carrierCode/carrierName joined in by the list endpoint.
export interface CompanyCarrier {
  id: string;
  carrierId: string;
  carrierCode: string;
  carrierName: string;
  customerNumber: string;
  createdAt: string;
}

export type NumberSeriesKey =
  | "purchase_order"
  | "sales_order"
  | "manufacturing_order"
  | "inquiry"
  | "invoice"
  | "supplier_invoice"
  | "customer_payment"
  | "supplier_payment"
  | "customer"
  | "supplier"
  | "fixed_asset"
  | "payment_batch"
  | "delivery"
  | "shipment"
  | "stock_count";

export const NUMBER_SERIES_LABELS: Record<NumberSeriesKey, string> = {
  purchase_order: "Inköpsorder",
  sales_order: "Kundorder",
  manufacturing_order: "Tillverkningsorder",
  inquiry: "Förfrågan",
  invoice: "Faktura",
  supplier_invoice: "Leverantörsfaktura",
  customer_payment: "Betalning",
  supplier_payment: "Utbetalning",
  customer: "Kundnummer",
  supplier: "Leverantörsnummer",
  fixed_asset: "Anläggning",
  payment_batch: "Betalfil",
  delivery: "Följesedel",
  shipment: "Försändelse",
  stock_count: "Inventering",
};

export interface NumberSeries {
  key: NumberSeriesKey;
  prefix: string;
  nextNumber: number;
  digits: number;
}

// --- Lönekoder: frånvarokoder & OB-tillägg ---

export interface AbsenceType {
  id: string;
  code: string;
  name: string;
  paxmlCode: string;
  active: boolean;
}

// A registered absence booking, as returned by GET /employees/:id/absences —
// the raw `absences` row columns plus the joined type's code/name/PAXml-kod
// (prefixed `absenceType*`, not `code`/`name` — there's no plain-named field).
export interface Absence {
  id: string;
  employeeId: string;
  absenceTypeId: string;
  date: string;
  minutes: number;
  note: string | null;
  createdBy: string | null;
  createdAt: string;
  absenceTypeCode: string;
  absenceTypeName: string;
  absenceTypePaxmlCode: string;
}

export type ObDayKind = "weekday" | "saturday" | "sunday" | "holiday";

export const OB_DAY_KIND_LABELS: Record<ObDayKind, string> = {
  weekday: "Vardag",
  saturday: "Lördag",
  sunday: "Söndag",
  holiday: "Helgdag",
};

export interface ObRule {
  id: string;
  code: string;
  name: string;
  dayKind: ObDayKind;
  startTime: string; // "HH:MM"
  endTime: string;
  paxmlCode: string;
  active: boolean;
}

// --- Löneperiod: sammanställning, attestering och låsning ---

// Swedish month names (lowercase), indexed by month number − 1. Used for the
// period label on the attestation page and in its confirm dialogs.
export const MONTH_NAMES_SV = [
  "januari",
  "februari",
  "mars",
  "april",
  "maj",
  "juni",
  "juli",
  "augusti",
  "september",
  "oktober",
  "november",
  "december",
] as const;

// Mirrors DayComputation in apps/api/src/modules/payroll/service/payroll-day.ts.
export interface DayComputation {
  date: string; // local YYYY-MM-DD
  scheduledMinutes: number;
  workedMinutes: number;
  absences: { code: string; paxmlCode: string; minutes: number }[];
  ob: { code: string; paxmlCode: string; minutes: number }[];
  overtimeMinutes: number; // over schedule on scheduled days
  overtimeOffScheduleMinutes: number; // any work on schedule-free days
  atfMinutes: number;
  unaccountedMinutes: number;
  // How this day's overtime is compensated (override ?? employee default).
  // Optional: pre-feature locked snapshots lack the fields — read as payout.
  overtimeDisposition?: OvertimeCompensation;
  overtimeDispositionSource?: "default" | "override";
}

// Mirrors PeriodEmployeeSummary in payroll.service.ts. Note `absence`
// (singular, with a name) vs the days' `absences` (no name).
export interface PeriodEmployeeSummary {
  employeeId: string;
  employeeNumber: string;
  name: string;
  employmentType: EmploymentType | null;
  scheduledMinutes: number;
  workedMinutes: number;
  absence: { code: string; name: string; paxmlCode: string; minutes: number }[];
  ob: { code: string; paxmlCode: string; minutes: number }[];
  overtimeMinutes: number;
  overtimeOffScheduleMinutes: number;
  atfMinutes: number;
  unaccountedMinutes: number;
  openAttendance: boolean;
  attested: boolean;
  attestedAt: string | null;
  attestedByName: string | null;
  days: DayComputation[];
  // Comp-time share of the overtime totals (payout = total − comp). Optional:
  // pre-feature locked snapshots lack them — read as 0.
  overtimeCompMinutes?: number;
  overtimeOffScheduleCompMinutes?: number;
}

// Mirrors PeriodSummary in payroll.service.ts — GET /periods/:year/:month.
export interface PeriodSummary {
  year: number;
  month: number;
  status: "open" | "locked";
  lockedAt: string | null;
  generatedAt: string;
  employees: PeriodEmployeeSummary[];
}

// GET /periods/:year/:month/employees/:employeeId/days — the day detail plus
// the raw rows the correction UI edits. The absence rows here are NOT the
// personalkort's `Absence` shape: they carry plain `code`/`name` fields.
export interface PeriodAttendanceSession {
  id: string;
  date: string; // local date of startedAt
  startedAt: string; // ISO instant
  stoppedAt: string | null; // null = still clocked in
}

export interface PeriodAbsenceRow {
  id: string;
  date: string;
  code: string;
  name: string;
  minutes: number;
  note: string | null;
}

export interface EmployeePeriodDays {
  days: DayComputation[];
  sessions: PeriodAttendanceSession[];
  absences: PeriodAbsenceRow[];
}

export type UserRole = "admin" | "supervisor" | "user";

export interface AdminUser {
  id: string;
  email: string;
  name: string;
  role: UserRole;
  active: boolean;
  createdAt: string;
  // Null unless the caller passed ?includeDeleted=true (only cross-module
  // lookups do — e.g. resolving a soft-deleted account's name on the
  // verifikat card — never the user-admin register, which always gets the
  // default filtered list).
  deletedAt: string | null;
  permissionGroupId: string | null;
  permissionGroupName: string | null;
}

export interface PermissionGroup {
  id: string;
  code: string;
  name: string;
  permissions: Permission[];
  userCount: number;
}

// --- Ekonomi (B1 grundbokföring): kontoplan, räkenskapsår och perioder ---
// Mirrors economy.repository.ts's `accounts` select. NOT the generic
// RegisterEntry shape: BAS legitimately repeats names, so only `number`
// (4 digits) is unique — listing sorts by number, not name.
export interface Account {
  id: string;
  number: string;
  name: string;
  active: boolean;
  vatBox: VatBoxSetting | null;
  createdAt: string;
}

export type AccountingPeriodStatus = "open" | "locked";

export const PERIOD_STATUS_LABELS: Record<AccountingPeriodStatus, string> = {
  open: "Öppen",
  locked: "Låst",
};

// One monthly period generated when its fiscal year was created — see
// economy.repository.ts's createFiscalYearWithPeriods/findFiscalYearById.
export interface AccountingPeriod {
  id: string;
  fiscalYearId: string;
  startDate: string;
  endDate: string;
  status: AccountingPeriodStatus;
  lockedAt: string | null;
  lockedBy: string | null;
}

// GET /fiscal-years list row — periodCount is a lightweight second query in
// the repo, not the full periods array (see FiscalYearDetail below).
export interface FiscalYear {
  id: string;
  label: string;
  startDate: string;
  endDate: string;
  createdAt: string;
  periodCount: number;
  status: "open" | "closed";
  closedAt: string | null;
}

// POST /fiscal-years and GET /fiscal-years/:id — the year plus every one of
// its generated monthly periods, sorted by startDate.
export interface FiscalYearDetail {
  id: string;
  label: string;
  startDate: string;
  endDate: string;
  createdAt: string;
  periods: AccountingPeriod[];
}

// --- Verifikatserier (verification series) ---
// GET /verification-series — small register (A = manuella; B2 adds more),
// code + name, no pagination.
export interface VerificationSeries {
  id: string;
  code: string;
  name: string;
  createdAt: string;
}

// --- Verifikat (B1 grundbokföring) ---
export type VerificationStatus = "draft" | "booked";

export const VERIFICATION_STATUS_PILL: Record<
  VerificationStatus,
  { status: "running" | "delayed" | "stopped" | "done" | "draft"; label: string }
> = {
  draft: { status: "draft", label: "Utkast" },
  booked: { status: "done", label: "Bokförd" },
};

// GET /verifications/:id row — verification_rows joined with the account's
// number/name (economy.repository.ts's findVerificationById). debit/credit
// are numeric(14,2) columns, so they arrive as strings, same convention as
// every other money column in this app.
export interface VerificationRow {
  id: string;
  verificationId: string;
  accountId: string;
  debit: string;
  credit: string;
  description: string | null;
  createdAt: string;
  accountNumber: string;
  accountName: string;
}

// Shared header fields — mirrors getTableColumns(verifications) plus the
// seriesCode/yearLabel join and the service-layered displayNumber
// ("A-2026-17" once booked, else "Utkast"). reversesVerificationId links a
// reversal draft (Omför) back to the booked source it mirrors — forward
// direction, present on both the list and the detail response.
export interface VerificationHeader {
  id: string;
  seriesId: string;
  fiscalYearId: string;
  verificationNumber: number | null;
  date: string;
  description: string;
  status: VerificationStatus;
  reversesVerificationId: string | null;
  createdBy: string | null;
  bookedBy: string | null;
  bookedAt: string | null;
  createdAt: string;
  updatedAt: string;
  seriesCode: string;
  yearLabel: string;
  displayNumber: string;
}

// GET /verifications list row — same shape as the header, no rows.
export type VerificationListRow = VerificationHeader;

// GET /verifications/:id — header + rows, plus the reverse-direction
// lookup: `reversedBy` is set on a SOURCE once some OTHER verification
// reverses it (economy.service.ts's findVerificationById, via
// repo.findReversalOf) — null otherwise. Only the detail endpoint resolves
// this (the list endpoint doesn't), so it lives here, not on
// VerificationHeader. A reversal may itself still be a draft, so
// reversedBy.displayNumber can read "Utkast" until it's booked too.
export interface VerificationDetail extends VerificationHeader {
  // Joined server-side (soft-deleted users included) — null when unset.
  createdByName: string | null;
  bookedByName: string | null;
  rows: VerificationRow[];
  reversedBy: { id: string; displayNumber: string } | null;
  // Underlag (kvitto, kontoutdrag…) — removable only while a draft.
  files: VerificationFile[];
  // Set for the fixed asset register's AV verifications (run, its reversal, disposal).
  fixedAsset: { kind: "depreciation_run" | "reversal" | "disposal"; runId: string | null; assetId: string | null } | null;
  // Set for the year-end guide's BS verifications (booking, reversal, cancellation).
  yearEnd: { closingId: string; fiscalYearId: string; fiscalYearLabel: string; step: YearEndStep; role: YearEndRole } | null;
}

export interface VerificationFile {
  id: string;
  verificationId: string;
  filename: string;
  contentType: string;
  sizeBytes: number;
  sha256: string;
  uploadedBy: string | null;
  createdAt: string;
}

// --- Huvudbok (B1 grundbokföring, general ledger) ---
// GET /ledger?accountId=&from=&to= row — mirrors economy.service.ts's
// getLedger: pure aggregation over BOOKED verifications only, re-derived on
// every call, never stored. debit/credit are numeric(14,2) strings (same
// convention as VerificationRow); balance is the running total after this
// row, already rounded server-side.
export interface LedgerRow {
  date: string;
  verificationId: string;
  displayNumber: string;
  description: string;
  debit: string;
  credit: string;
  balance: number;
}

// GET /ledger?accountId=&from=&to= response.
export interface LedgerResponse {
  accountId: string;
  accountNumber: string;
  accountName: string;
  from: string | null;
  to: string | null;
  openingBalance: number;
  closingBalance: number;
  rows: LedgerRow[];
}

// --- Automatkontering (B2): konteringsregler ---
// GET /posting-rules row — postingRules table columns plus the joined
// artikelgrupp/konto names (economy.repository.ts's listPostingRules), a
// plain array (no pagination). vatRate is a numeric(5,2) column, so it comes
// back as a string ("25.00") or null — null is the catch-all rule ("Alla
// satser" in the UI), applied when no rate-specific rule matches the row.
export interface PostingRule {
  id: string;
  articleGroupId: string;
  vatRate: string | null;
  revenueAccountId: string | null;
  costAccountId: string | null;
  createdAt: string;
  groupCode: string;
  groupName: string;
  revenueAccountNumber: string | null;
  revenueAccountName: string | null;
  costAccountNumber: string | null;
  costAccountName: string | null;
}

// --- Anläggningsregister (ekonomi etapp 2, delprojekt 2) ---
export interface FixedAssetAccountRef {
  id: string;
  number: string;
  name: string;
  active: boolean;
  vatBox: string | null;
}

export interface FixedAssetCategory {
  id: string;
  name: string;
  assetAccountId: string;
  accumulatedDepreciationAccountId: string;
  depreciationExpenseAccountId: string;
  disposalGainAccountId: string;
  disposalLossAccountId: string;
  defaultUsefulLifeMonths: number;
  accounts: Record<"asset" | "accumulated" | "expense" | "gain" | "loss", FixedAssetAccountRef>;
  assetCount: number;
  // Tillgångskonto/ack-konto/kostnadskonto are locked once the group has
  // booked or opening depreciation (409 fixed-asset-category-accounts-locked).
  postingAccountsLocked: boolean;
  createdAt: string;
  updatedAt: string;
}

// GET /fixed-assets row. Amount columns are numeric(14,2) strings (repo
// convention); the derived figures are numbers.
export interface FixedAsset {
  id: string;
  assetNumber: string;
  name: string;
  note: string | null;
  categoryId: string;
  categoryName: string;
  acquisitionDate: string;
  acquisitionCost: string;
  residualValue: string;
  usefulLifeMonths: number;
  depreciationStartMonth: string; // "YYYY-MM-01"
  // Ingående avskrivning: accumulated depreciation already in the opening
  // balance for assets acquired before Nav, valid through that month.
  openingDepreciation: string;
  openingDepreciationThroughMonth: string | null; // "YYYY-MM-01"
  status: FixedAssetStatus;
  disposalDate: string | null;
  disposalType: FixedAssetDisposalType | null;
  disposalPrice: string | null;
  disposalVerificationId: string | null;
  supplierInvoiceId: string | null;
  accumulatedDepreciation: number;
  bookValue: number;
  createdAt: string;
  updatedAt: string;
}

export interface FixedAssetDepreciationRow {
  id: string;
  month: string; // "YYYY-MM"
  amount: number;
  runId: string;
  verificationId: string;
  displayNumber: string;
  date: string;
  reversed: boolean;
}

export interface FixedAssetDetail extends Omit<FixedAsset, "categoryName"> {
  category: FixedAssetCategory;
  depreciations: FixedAssetDepreciationRow[];
  plannedMonths: { month: string; amount: number }[];
  // Booked depreciation months of the register; EXCLUDES the opening months.
  bookedMonthCount: number;
  disposalVerification: { id: string; displayNumber: string; date: string } | null;
  supplierInvoice: { id: string; registrationNumber: string } | null;
}

export interface DepreciationRun {
  id: string;
  throughMonth: string;
  createdAt: string;
  disposalAssetId: string | null;
  disposalAssetNumber: string | null;
  verification: { id: string; displayNumber: string; date: string };
  reversalVerification: { id: string; displayNumber: string } | null;
  rowCount: number;
  amount: number;
  undoable: boolean;
}

export interface DepreciationCategoryTotal {
  categoryId: string;
  categoryName: string;
  expenseAccountNumber: string;
  accumulatedAccountNumber: string;
  amount: number;
}

export interface DepreciationPreview {
  throughMonth: string;
  date: string;
  periodStatus: "open" | "locked" | "none";
  lastRun: { id: string; throughMonth: string; displayNumber: string; date: string } | null;
  assets: {
    assetId: string;
    assetNumber: string;
    name: string;
    categoryName: string;
    months: { month: string; amount: number }[];
    catchUpMonths: string[];
    amount: number;
  }[];
  byCategory: DepreciationCategoryTotal[];
  total: number;
  warnings: ("period-locked" | "no-period" | "month-in-future" | "inactive-account")[];
  // Filled when warnings includes "inactive-account": which group account
  // was deactivated in the chart of accounts.
  inactiveAccounts: { accountNumber: string; accountName: string; categoryName: string; role: "expense" | "accumulated" }[];
}

export interface DepreciationRunResult {
  run: { id: string; throughMonth: string };
  verification: { id: string; displayNumber: string };
  total: number;
}

export interface DisposalPreview {
  asset: { id: string; assetNumber: string; name: string };
  disposalType: FixedAssetDisposalType;
  disposalDate: string;
  catchUpMonths: { month: string; amount: number }[];
  accumulatedDepreciation: number;
  bookValue: number;
  disposalPrice: number;
  gain: number;
  loss: number;
  // In booked order: asset, accumulated, intermediate, gain, loss.
  rows: { accountNumber: string; accountName: string; debit: number; credit: number }[];
  warnings: "intermediate-account-not-box-05"[];
}

export interface DisposalResult {
  asset: FixedAssetDetail;
  depreciationRun: { id: string; displayNumber: string } | null;
  disposalVerification: { id: string; displayNumber: string };
}

export interface FixedAssetPlanTotals {
  acquisitionOpening: number;
  acquisitions: number;
  disposals: number;
  acquisitionClosing: number;
  depreciationOpening: number;
  depreciationYear: number;
  depreciationDisposed: number;
  depreciationClosing: number;
  bookValueClosing: number;
}

export interface FixedAssetPlanRow extends FixedAssetPlanTotals {
  assetId: string;
  assetNumber: string;
  name: string;
  acquisitionDate: string;
  disposalDate: string | null;
}

export interface FixedAssetPlan {
  fiscalYear: { id: string; label: string; startDate: string; endDate: string };
  categories: {
    categoryId: string;
    categoryName: string;
    assetAccountNumber: string;
    accumulatedAccountNumber: string;
    assets: FixedAssetPlanRow[];
    totals: FixedAssetPlanTotals;
  }[];
  totals: FixedAssetPlanTotals;
  reconciliation: {
    accountId: string;
    accountNumber: string;
    accountName: string;
    kind: "asset" | "accumulated";
    registerAmount: number;
    ledgerAmount: number;
    difference: number;
    mismatch: boolean;
  }[];
}

// Swedish label for a posting rule's momssats — null = the catch-all rule.
export function postingVatRateLabel(rate: string | number | null): string {
  if (rate === null) return "Alla satser";
  return `${Number(rate)} %`;
}

// --- Momsrapport (B5) ---
// GET /vat-report?from=&to= — Skatteverkets deklarationsrutor för en månad
// eller ett kvartal, härledda ur bokförda verifikat.
export interface VatReportBoxes {
  sales05: number;
  salesEu35: number;
  salesExport36: number;
  salesExempt42: number;
  vatOut25_10: number;
  vatOut12_11: number;
  vatOut6_12: number;
  vatIn48: number;
  vatToPay49: number;
}

// The four configured VAT accounts' movements — the momsomföring preview.
export interface VatAccountPreview {
  role: "vatOut25" | "vatOut12" | "vatOut6" | "vatIn";
  accountId: string;
  accountNumber: string;
  accountName: string;
  debit: number;
  credit: number;
  net: number;
}

export interface VatReportSettlement {
  id: string;
  fromDate: string;
  toDate: string;
  verificationId: string;
  displayNumber: string;
  date: string;
  createdAt: string;
  reversed: boolean;
  reversedBy: { id: string; displayNumber: string } | null;
}

// Momsruta per konto: accounts the report could not place in a box, and a
// configured VAT account whose box does not match its role.
export interface VatUnassignedAccount {
  accountNumber: string;
  accountName: string;
  net: number;
}

export interface VatRoleBoxMismatch {
  role: "vatOut25" | "vatOut12" | "vatOut6" | "vatIn" | "revenue25" | "revenue12" | "revenue6" | "revenue0";
  accountNumber: string;
  expectedBox: VatBox;
  actualBox: string | null;
}

export interface VatReportResponse {
  from: string;
  to: string;
  boxes: VatReportBoxes;
  vatAccounts: VatAccountPreview[];
  settlements: VatReportSettlement[];
  periods: { id: string; startDate: string; endDate: string; status: AccountingPeriodStatus }[];
  warnings: { unassignedAccounts: VatUnassignedAccount[]; roleBoxMismatches: VatRoleBoxMismatch[] };
}

// --- Ekonomirapporter (B6a) ---
// Hand-mirrored from
// apps/api/src/modules/economy/service/financial-reports.service.ts — the web
// app cannot import @navet/shared (Turbopack vs .js-suffix imports). Line and
// group LABELS come from the API, not a table here: unlike the VAT report's
// fixed box set, these lines are data-driven from the BAS interval table, and
// a second copy of the labels would silently drift.

export interface ReportAccount {
  accountId: string;
  accountNumber: string;
  accountName: string;
  amount: number;
}

export interface BalanceSheetLine {
  key: string;
  label: string;
  computed: boolean;
  accounts: ReportAccount[];
  total: number;
}

export interface BalanceSheetGroup {
  key: string;
  label: string;
  lines: BalanceSheetLine[];
  total: number;
}

export interface BalanceSheetResponse {
  asOf: string;
  fiscalYear: { id: string; label: string; startDate: string; endDate: string };
  assets: { groups: BalanceSheetGroup[]; total: number };
  equityAndLiabilities: { groups: BalanceSheetGroup[]; total: number };
  // Always 0 — the UI only surfaces it when double-entry has somehow broken.
  difference: number;
}

export type IncomeStatementEntry =
  | { kind: "line"; key: string; label: string; accounts: ReportAccount[]; total: number }
  | { kind: "subtotal"; key: string; label: string; total: number };

export interface IncomeStatementResponse {
  from: string;
  to: string;
  entries: IncomeStatementEntry[];
  result: number;
}

export interface GeneralLedgerAccount {
  accountId: string;
  accountNumber: string;
  accountName: string;
  openingBalance: number;
  closingBalance: number;
  totalDebit: number;
  totalCredit: number;
  rows: LedgerRow[];
}

export interface GeneralLedgerResponse {
  from: string;
  to: string;
  accountFrom: string;
  accountTo: string;
  accounts: GeneralLedgerAccount[];
  totalDebit: number;
  totalCredit: number;
}

// --- Inventering (D2) ---

export type StockCountStatus = "open" | "posted" | "cancelled";

export const STOCK_COUNT_STATUS_LABELS: Record<StockCountStatus, string> = {
  open: "Pågår",
  posted: "Registrerad",
  cancelled: "Avbruten",
};

export interface StockCountSession {
  id: string;
  countNumber: string;
  locationId: string;
  locationName: string;
  warehouseName: string;
  status: StockCountStatus;
  blocksTransactions: boolean;
  createdAt: string;
  postedAt: string | null;
  rowCount: number;
  countedCount: number;
}

export interface StockCountRow {
  id: string;
  articleId: string;
  articleNumber: string;
  articleName: string;
  unit: string | null;
  snapshotQuantity: string;
  countedQuantity: string | null;
  note: string | null;
  disturbed: boolean;
}

export interface StockCountDetail extends StockCountSession {
  note: string | null;
  rows: StockCountRow[];
}

// POST /stock-counts/:id/post
export interface StockCountPostResult {
  session: { id: string; status: StockCountStatus };
  adjustments: number;
  counted: number;
  skipped: number;
}

// Behovsberäkning (MRP light, E1). GET /planning/requirements — one row per
// article with any demand/supply/stock/reorder point (or, by default, only
// those with a proposalQuantity > 0). Never stored — fully derived server-side.
export interface RequirementRow {
  articleId: string;
  articleNumber: string;
  articleName: string;
  type: "manufactured" | "purchased";
  unitCode: string | null;
  groupId: string | null;
  active: boolean;
  onHand: number;
  demandSales: number;
  demandMo: number;
  demandDerived: number;
  supplyPo: number;
  // Open quantity on DRAFT purchase orders — counted separately so re-running
  // the routine doesn't re-propose material already put on a draft IO.
  supplyPoDraft: number;
  supplyMo: number;
  projected: number;
  reorderPoint: number | null;
  orderQuantity: number | null;
  rounding: number | null;
  proposalQuantity: number;
  proposalKind: "purchase" | "manufacture" | "subcontract" | "configured" | null;
  primarySupplier: {
    supplierId: string;
    supplierName: string;
    price: number | null;
    currency: string;
    leadTimeDays: number | null;
  } | null;
  // Subcontract (lego) rows only: which MO operation the proposal buys.
  // These rows are keyed per operation — the same article can appear on
  // several lego rows — and are never netted against stock.
  moOperationId?: string;
  moOrderNumber?: string;
  moOperationLabel?: string;
  // Lego rows only: existing förfrågningar (draft/sent/answered) already
  // covering this operation, so the routine doesn't propose duplicate
  // inquiries — shown as links under the row.
  openInquiries?: { id: string; inquiryNumber: string; status: InquiryStatus }[];
  // Konfigurator 4c: a beställningsvara template never gets a proposal of its own.
  configuredTemplate?: boolean;
  // Configured sales-order rows only (proposalKind "configured"); keyed per row.
  salesOrderRowId?: string;
  salesOrderId?: string;
  salesOrderNumber?: string;
  customerName?: string;
  configurationSummary?: string;
  expectedDeliveryDate?: string | null;
  configurationError?: string | null;
}

// Artikelöversikt (planeringsbild). GET /articles/:id/overview — mirrors
// apps/api/src/modules/planning/service/article-overview.ts. Every open
// demand/supply row for ONE article in date order with a running balance;
// same status rules as the behovsberäkning, never stored.
export type OverviewRowKind =
  | "sales_order"
  | "mo_material"
  | "mo_planned_material"
  | "manufacturing_order"
  | "purchase_order";

export const OVERVIEW_KIND_LABELS: Record<OverviewRowKind, string> = {
  sales_order: "Kundorder",
  mo_material: "Material till TO",
  mo_planned_material: "Material till planerad TO",
  manufacturing_order: "Tillverkningsorder",
  purchase_order: "Inköpsorder",
};

export interface ArticleOverviewRow {
  id: string;
  kind: OverviewRowKind;
  direction: "demand" | "supply";
  date: string | null;
  documentType: "sales_order" | "purchase_order" | "manufacturing_order";
  documentId: string;
  documentNumber: string;
  status: string;
  partner: string | null;
  // Signed: demand < 0, supply > 0.
  quantity: number;
  // onHand + Σ quantity up to and including this row.
  balance: number;
  // Draft IO — counted (like supplyPoDraft) but marked "Utkast".
  isDraft: boolean;
}

export interface ArticleOverview {
  article: {
    articleId: string;
    articleNumber: string;
    name: string;
    type: ArticleType;
    isPhantom: boolean;
    active: boolean;
    unitCode: string | null;
    reorderPoint: number | null;
    orderQuantity: number | null;
    rounding: number | null;
  };
  primarySupplier: { supplierId: string; supplierName: string; leadTimeDays: number | null } | null;
  onHand: number;
  rows: ArticleOverviewRow[];
  closingBalance: number;
}

// POST /planning/orders — proposals are grouped server-side into one draft
// purchase order per primary supplier; an article without one comes back in
// `errors` instead. Subcontract proposals are keyed by moOperationId and
// grouped per the operation's supplier.
export interface PlanningOrderProposal {
  articleId: string;
  quantity: number;
  kind: "purchase" | "manufacture" | "subcontract" | "configured";
  moOperationId?: string;
  // Required for kind "configured": configured rows share articleId with the template's own row.
  salesOrderRowId?: string;
}

export interface PlanningOrdersResult {
  // supplierId is what the "Maila"-button on the result card resolves the
  // recipient from (see fetchDefaultRecipient in lib/mail.ts).
  purchaseOrders: { id: string; orderNumber: string; supplierId: string; supplierName: string; rowCount: number }[];
  manufacturingOrders: { id: string; orderNumber: string; articleNumber: string }[];
  errors: { articleId: string; articleNumber: string; message: string }[];
  // Fasta leveransdagar: IO rows whose earliest arrival comes after the demand.
  warnings: { orderNumber: string; articleNumber: string; demandDate: string; deliveryDate: string; message: string }[];
}

// One förfrågan created by createLegoInquiries (lib/legoInquiries.ts) —
// mirrors PlanningOrdersResult's purchaseOrders entries, but per inquiry
// rather than per PO.
export interface CreatedInquiry {
  id: string;
  inquiryNumber: string;
  supplierId: string;
  supplierName: string;
  rowCount: number;
}

// One lego proposal row going into createLegoInquiries — a trimmed-down
// RequirementRow carrying just what POST /inquiries needs plus the
// articleNumber for error reporting.
export interface LegoInquiryRowInput {
  articleId: string;
  articleNumber: string;
  quantity: number;
  moOperationId?: string;
  routingOperationId?: string;
  setupPrice?: number;
}

// --- Rapporter (F1) ---
// GET /reports/delivery-precision?from=YYYY-MM&to=YYYY-MM — sales and
// purchase are measured separately (see docs/manual/rapporter.md).
export interface PrecisionMonth {
  month: string;
  total: number;
  onTime: number;
  late: number;
  precisionPct: number | null;
  avgDaysLate: number | null;
}

export interface PrecisionSection {
  months: PrecisionMonth[];
  totals: {
    total: number;
    onTime: number;
    late: number;
    precisionPct: number | null;
    avgDaysLate: number | null;
  };
  notMeasurable: { missingExpectedDate: number; noDeliveryRecords: number };
}

export interface DeliveryPrecisionResponse {
  from: string;
  to: string;
  sales: PrecisionSection;
  purchase: PrecisionSection;
}

// GET /reports/sales-statistics?from&to&groupBy=month|customer|article
export interface StatisticsRow {
  key: string;
  label: string;
  netAmount: number;
  quantity: number | null;
  invoiceCount: number;
}

export interface SalesStatisticsResponse {
  from: string;
  to: string;
  groupBy: string;
  rows: StatisticsRow[];
  totalNet: number;
}

// GET /reports/purchase-statistics?from&to&groupBy=month|supplier|article —
// same row shape as sales; `basis` tells whether the totals come from the
// invoice header (month/supplier) or the summed rows (article), see
// docs/manual/rapporter.md.
export interface PurchaseStatisticsResponse {
  from: string;
  to: string;
  groupBy: string;
  rows: StatisticsRow[];
  totalNet: number;
  basis: "header" | "rows";
}

// GET /reports/scrap-statistics?from&to&groupBy=month|article|workCenter|reason
export interface ScrapRow {
  key: string;
  label: string;
  scrappedQuantity: number;
  reportCount: number;
}

export interface ScrapStatisticsResponse {
  from: string;
  to: string;
  groupBy: string;
  rows: ScrapRow[];
  totalScrapped: number;
}

// GET /reports/calculation-outcome?from&to — pre- vs post-kalkyl TVK per unit.
export interface OutcomeRow {
  manufacturingOrderId: string;
  orderNumber: string;
  articleNumber: string;
  articleName: string;
  quantity: number;
  preTvkPerUnit: number;
  postTvkPerUnit: number;
  deltaPerUnit: number;
  deltaPct: number | null;
  preCalculatedAt: string;
  postCalculatedAt: string;
  // The pre-calculation resolved sub-assemblies recursively, so its TVK holds
  // each sub-assembly's own manufacturing cost while the post-calculation holds
  // what it was received at — a large deviation on such a row can be a
  // difference in method rather than in production.
  preMultiLevel: boolean;
}

export interface CalculationOutcomeResponse {
  from: string;
  to: string;
  rows: OutcomeRow[];
  summary: { count: number; avgDeviationPct: number | null };
  notComparable: { onlyPre: number; onlyPost: number; invalidQuantity: number };
}

// --- Händelselogg (G1): read side of the append-only audit_log ---

export interface AuditLogEntry {
  id: string;
  entityType: string;
  entityId: string | null;
  action: string;
  detail: unknown;
  userId: string | null;
  userName: string | null;
  createdAt: string;
}

// Swedish labels for the audit trail's entityType/action vocabulary — MIRROR
// of apps/api/src/modules/system/service/audit-log-labels.ts (the web app
// cannot import @navet/shared, see EMAIL_DOCUMENT_TYPE_LABELS's own comment
// above for why plain objects get duplicated instead of shared). Both maps
// are deliberately incomplete — every writer across the modules logs its own
// entityType/action strings (CLAUDE.md's "Bindande konventioner"), and an
// entry missing here just falls back to its raw string via
// auditEntityTypeLabel/auditActionLabel below rather than rendering blank.
export const AUDIT_ENTITY_TYPE_LABELS: Record<string, string> = {
  system: "System",
  api_client: "API-klient",
  absence: "Frånvaro",
  year_end_closing: "Bokslut",
  overtime_disposition: "Övertidsdisposition",
  payroll_period: "Löneperiod",
  payroll_attestation: "Löneattestering",
  attendance_session: "Stämpling",
  time_report: "Tidrapport",
  accounting_period: "Bokföringsperiod",
  verification: "Verifikat",
  sales_order: "Kundorder",
  sales_order_row: "Kundorderrad",
  invoice: "Faktura",
  delivery: "Följesedel",
  purchase_order: "Inköpsorder",
  purchase_order_row: "Inköpsorderrad",
  inquiry: "Förfrågan",
  supplier_invoice: "Leverantörsfaktura",
  supplier_payment: "Leverantörsbetalning",
  customer_payment: "Kundbetalning",
  price_list: "Prislista",
  customer_price: "Kundpris",
  manufacturing_order: "Tillverkningsorder",
  stock_count_session: "Inventering",
  user: "Användare",
  system_settings: "Inställningar",
  company_info: "Företagsinformation",
  number_series: "Nummerserie",
  fixed_asset: "Anläggning",
  fixed_asset_category: "Anläggningsgrupp",
  fixed_asset_depreciation_run: "Avskrivningskörning",
  // Bankfiler (ISO 20022).
  payment_batch: "Betalfil",
  bank_file: "Bankfil",
  bank_settings: "Bankinställningar",
};

export const AUDIT_ACTION_LABELS: Record<string, string> = {
  demo_data_created: "Exempeldata skapad",
  created: "Skapad",
  updated: "Ändrad",
  onboarding_number_series_reviewed: "Nummerserier granskade",
  deleted: "Borttagen",
  set: "Satt",
  cleared: "Rensad",
  attested: "Attesterad",
  unattested: "Attestering borttagen",
  locked: "Låst",
  unlocked: "Upplåst",
  booked: "Bokförd",
  reversal_created: "Omföring skapad",
  paxml_exported: "PAXml-export",
  confirmed: "Bekräftad",
  cancelled: "Avbruten",
  issued: "Utfärdad",
  released: "Frisläppt",
  started: "Startad",
  report_undone: "Rapportering ångrad",
  closed: "Stängd",
  completed: "Färdigrapporterad",
  posted: "Bokförd",
  delivered: "Levererad",
  row_added: "Rad tillagd",
  row_updated: "Rad ändrad",
  row_deleted: "Rad borttagen",
  row_configuration_changed: "Konfiguration ändrad",
  file_added: "Underlag uppladdat",
  file_deleted: "Underlag borttaget",
  goods_received: "Gods mottaget",
  credit_created: "Kreditfaktura skapad",
  reminder_sent: "Påminnelse skickad",
  logo_updated: "Logotyp uppdaterad",
  sent: "Skickad",
  answered: "Besvarad",
  payment_reference_changed: "Betalningsreferens ändrad",
  exported: "Exporterad",
  items_added: "Poster tillagda",
  item_updated: "Post ändrad",
  item_removed: "Post borttagen",
  item_confirmed: "Post bekräftad",
  item_rejected: "Post avvisad",
  item_returned: "Post returnerad",
  uploaded: "Uppladdad",
  entry_booked: "Post bokförd",
  entry_ignored: "Post markerad som hanterad utanför Nav",
  entry_restored: "Post återställd",
};

export function auditEntityTypeLabel(entityType: string): string {
  return AUDIT_ENTITY_TYPE_LABELS[entityType] ?? entityType;
}

export function auditActionLabel(action: string): string {
  return AUDIT_ACTION_LABELS[action] ?? action;
}

// GET /reports/order-margin — täckningsbidrag on invoiced revenue, grouped by
// month, customer or article. cost/contribution/marginPercent are null when no
// row in the group had a saved pre-calculation: unknown, never zero.
export interface MarginGroup {
  key: string;
  label: string;
  netRevenue: number;
  // Revenue for the rows that HAD a calculation — what the margin is measured
  // against, so a partial cost is never subtracted from a full revenue.
  costedNetRevenue: number;
  cost: number | null;
  contribution: number | null;
  marginPercent: number | null;
  rowsWithoutCost: number;
}

export interface OrderMarginResponse {
  from: string;
  to: string;
  groupBy: string;
  groups: MarginGroup[];
  total: MarginGroup;
}

// --- Frakt (Sendify) ---

export type ParcelKind = "package" | "pallet" | "other";
export type ShipmentStatus = "draft" | "booked" | "delivered" | "cancelled";

export interface FreightSettings {
  enabled: boolean;
  environment: "sandbox" | "production";
  apiKeySet: boolean;
  senderContactName: string;
  senderPhone: string;
  senderEmail: string;
  markupPercent: number;
  markupAmount: number;
  freightArticleId: string | null;
  priceChangePercent: number;
  trackingInterval: "hourly" | "every_4h" | "daily";
  lastTrackingRunAt: string | null;
}

export interface PickupTime {
  weekday: number;
  timeFrom: string;
  timeTo: string;
}

export interface FreightProduct {
  id: string;
  provider: string;
  carrierCode: string;
  carrierName: string;
  productName: string;
  createdAt: string;
}

export interface ShipmentRate {
  id: string;
  carrierCode: string;
  carrierName: string;
  productName: string;
  price: number;
  currency: string;
  daysMin: number | null;
  daysMax: number | null;
  pickupDate: string | null;
  estimatedDeliveryDate: string | null;
  expiresAt: string | null;
  customerPrice: number | null;
}

export interface ShipmentRates {
  fetchedAt: string;
  warnings: string[];
  rates: ShipmentRate[];
}

// GET /sales-orders/:id/freight — the order's chosen freight product and the
// carrier price it was quoted at (Sendify's price, not the customer price).
export interface OrderFreight {
  freightProduct: { id: string; carrierName: string; productName: string } | null;
  carrierPrice: number | null;
  rates: ShipmentRates | null;
}

export interface ShipmentParcel {
  id: string;
  position: number;
  parcelKind: ParcelKind;
  lengthCm: number;
  widthCm: number;
  heightCm: number;
  weightKg: number;
  quantity: number;
  stackable: boolean;
  loadingMeters: number | null;
  description: string | null;
}

export interface ShipmentDetail {
  id: string;
  shipmentNumber: string;
  status: ShipmentStatus;
  customerId: string;
  customerName: string;
  recipientName: string;
  recipientAddressLine1: string | null;
  recipientAddressLine2: string | null;
  recipientPostalCode: string | null;
  recipientCity: string | null;
  recipientCountry: string;
  recipientContactName: string | null;
  recipientPhone: string | null;
  recipientEmail: string | null;
  recipientPrivatePerson: boolean;
  senderName: string | null;
  senderAddressLine1: string | null;
  senderAddressLine2: string | null;
  senderPostalCode: string | null;
  senderCity: string | null;
  senderCountry: string;
  senderContactName: string | null;
  senderPhone: string | null;
  senderEmail: string | null;
  senderReference: string | null;
  senderReferenceManual: boolean;
  receiverReference: string | null;
  pickupDate: string;
  pickupFrom: string;
  pickupTo: string;
  freightProduct: { id: string; carrierCode: string; carrierName: string; productName: string } | null;
  carrierPrice: number | null;
  carrierCurrency: string | null;
  customerPrice: number | null;
  customerPriceManual: boolean;
  trackingNumber: string | null;
  trackingUrl: string | null;
  bookedAt: string | null;
  cancelledAt: string | null;
  createdAt: string;
  bookingInProgress: boolean;
  pickupWarning: string | null;
  tracking: {
    status: string | null;
    text: string | null;
    exception: boolean;
    checkedAt: string | null;
    deliveredAt: string | null;
    events: { occurredAt: string; status: string; statusLabel: string; description: string | null; location: string | null }[];
  };
  invoice: { invoiceId: string; invoiceNumber: string | null; status: "draft" | "issued" | "paid" } | null;
  rates: ShipmentRates | null;
  deliveries: { id: string; deliveryNumber: string; orderId: string; orderNumber: string; deliveredAt: string; active: boolean }[];
  parcels: ShipmentParcel[];
  files: { id: string; kind: string; filename: string; sizeBytes: number; createdAt: string }[];
}

export interface ShipmentListRow {
  id: string;
  shipmentNumber: string;
  status: ShipmentStatus;
  customerId: string;
  customerName: string;
  deliveryNumbers: string | null;
  carrierName: string | null;
  productName: string | null;
  trackingNumber: string | null;
  trackingText: string | null;
  trackingException: boolean;
  deliveredAt: string | null;
  pickupDate: string;
  createdAt: string;
}

export interface OpenDelivery {
  id: string;
  deliveryNumber: string;
  deliveredAt: string;
  orderId: string;
  orderNumber: string;
}

export interface DeliveryShipmentInfo {
  shipmentId: string;
  shipmentNumber: string;
  status: ShipmentStatus;
  carrierName: string | null;
  trackingNumber: string | null;
}

// --- Årsbokslut (ekonomi etapp 2, delprojekt 3) ---
export interface YearEndVerificationRef {
  id: string;
  displayNumber: string;
  date: string;
}

export interface YearEndCheck {
  code: string;
  message: string;
}

export interface YearEndAccrualRow {
  id: string;
  kind: YearEndAccrualKind;
  balanceAccountId: string;
  balanceAccountNumber: string;
  resultAccountId: string;
  resultAccountNumber: string;
  amount: number;
  description: string;
}

export interface YearEndClosingDetail {
  id: string;
  fiscalYearId: string;
  status: "in_progress" | "closed";
  closingDate: string;
  // True once a step is booked (steg 3's AV run included) — the API then
  // refuses a new closing date.
  closingDateLocked: boolean;
  createdAt: string;
  fiscalYear: { id: string; label: string; startDate: string; endDate: string; status: "open" | "closed"; closedAt: string | null };
  closingPeriod: { id: string; startDate: string; endDate: string; status: "open" | "locked" };
  nextFiscalYear: {
    id: string;
    label: string;
    startDate: string;
    endDate: string;
    status: "open" | "closed";
    firstPeriodStatus: "open" | "locked" | null;
  } | null;
  history: { verification: YearEndVerificationRef; step: YearEndStep; role: YearEndRole }[];
  defaultInventoryMethod: ValuationMethod;
  steps: {
    inventory: {
      status: "not_done" | "done" | "stale";
      method: ValuationMethod | null;
      value: number | null;
      verification: YearEndVerificationRef | null;
      bookedAt: string | null;
      ledger: number | null;
    };
    depreciation: { status: "done" | "missing"; throughMonth: string; missingAssets: number; missingAmount: number };
    accruals: {
      status: "not_done" | "done";
      rows: YearEndAccrualRow[];
      verification: YearEndVerificationRef | null;
      reversalVerification: YearEndVerificationRef | null;
      bookedAt: string | null;
    };
    resultTransfer: { status: "not_done" | "done" | "stale"; net: number; yearResult: number; verification: YearEndVerificationRef | null };
  };
  checks: {
    stepBlockers: YearEndCheck[];
    closeBlockers: YearEndCheck[];
    warnings: YearEndCheck[];
    // The drafts behind the "draft-verifications" blocker, at most 20.
    draftVerifications: { id: string; date: string; description: string }[];
  };
  ibCheck: {
    nextFiscalYearLabel: string;
    imports: string[];
    differences: { accountNumber: string; accountName: string; ub: number; ib: number; difference: number }[];
  } | null;
  profitDisposition: {
    id: string;
    agmDate: string;
    resultAmount: number;
    dividendAmount: number;
    verification: YearEndVerificationRef | null;
  } | null;
}

export interface YearEndPostingRow {
  accountNumber: string;
  accountName?: string;
  debit: number;
  credit: number;
}

export interface InventoryPreview {
  asOf: string;
  method: ValuationMethod;
  value: number;
  unvaluedCount: number;
  unvaluedArticles: { articleNumber: string; articleName: string; quantity: number; unit: string }[];
  ledgerBalance: number;
  ledgerExcludingStep: number;
  difference: number;
  rows: YearEndPostingRow[];
  unchanged: boolean;
}

export interface ResultTransferPreview {
  status: "not_done" | "done" | "stale";
  net: number;
  yearResult: number;
  rows: YearEndPostingRow[];
}

export interface ProfitDispositionPreview {
  resultAmount: number;
  dividend: number;
  freeEquity: number;
  rows: YearEndPostingRow[];
  warnings: string[];
}

export interface YearEndBookResult {
  unchanged: boolean;
  verification: YearEndVerificationRef | null;
}

// Bankfiler: GET /bank-settings (bank-settings.service.ts BankSettingsView).
export type BankProfileId = "handelsbanken" | "seb" | "swedbank" | "nordea";
export type DebitAccountKind = "iban" | "bankgiro" | "plusgiro";
export interface BankProfileView {
  id: BankProfileId;
  name: string;
  verified: boolean;
  initiatingPartyLabel: string;
  initiatingPartyRequired: boolean;
  debtorAgreementLabel: string | null;
  debitAccountKinds: DebitAccountKind[];
}
export interface BankSettingsView {
  profile: BankProfileId | null;
  initiatingPartyId: string | null;
  debtorAgreementId: string | null;
  debitAccountKind: DebitAccountKind | null;
  profiles: BankProfileView[];
  company: { name: string; orgNumber: string | null; postalCode: string | null; city: string | null; iban: string | null; bic: string | null; bankgiro: string | null; plusgiro: string | null };
  missing: string[];
}

// Bankfiler.
export type SupplierPaymentMethodValue = "bankgiro" | "plusgiro" | "bank_account" | "iban";
export interface SupplierPaymentFields {
  paymentMethod: SupplierPaymentMethodValue | null;
  bankgiro: string | null;
  plusgiro: string | null;
  bankClearing: string | null;
  bankAccountNumber: string | null;
  iban: string | null;
  bic: string | null;
}
export interface CreditorView {
  method: SupplierPaymentMethodValue;
  account: string | null;
  clearing: string | null;
  bic: string | null;
  name: string;
  postalCode: string | null;
  city: string | null;
  referenceKind: "ocr" | "message";
  reference: string;
}
export interface PaymentBatchListRow {
  id: string;
  batchNumber: string;
  status: "draft" | "exported" | "confirmed" | "cancelled";
  createdAt: string;
  exportedAt: string | null;
  itemCount: number;
  confirmedCount: number;
  totalAmount: number;
  earliestExecutionDate: string | null;
}
export interface PaymentBatchItem {
  id: string;
  seq: number;
  endToEndId: string;
  status: "pending" | "exported" | "confirmed" | "rejected" | "returned" | "cancelled";
  amount: number;
  executionDate: string;
  supplierInvoiceId: string;
  registrationNumber: string;
  invoiceNumber: string;
  supplierId: string;
  supplierName: string;
  creditor: CreditorView | null;
  rejectedReason: string | null;
  payment: { id: string; paymentNumber: string; cancelledAt: string | null } | null;
  warnings: string[];
}
export interface PaymentBatchDetail {
  id: string;
  batchNumber: string;
  status: PaymentBatchListRow["status"];
  bankAccountNumber: string;
  bankProfile: string | null;
  note: string | null;
  exportedAt: string | null;
  confirmedAt: string | null;
  cancelledAt: string | null;
  createdAt: string;
  updatedAt: string;
  totalAmount: number;
  itemCount: number;
  confirmedCount: number;
  file: { id: string; filename: string; sha256: string; createdAt: string } | null;
  items: PaymentBatchItem[];
}
export interface BankItemResult {
  itemId?: string;
  entryId?: string;
  ok: boolean;
  paymentNumber?: string;
  error?: { error: string; code?: string };
}
export interface BankFileListRow {
  id: string;
  filename: string;
  bankMessageId: string | null;
  bankCreatedAt: string | null;
  createdAt: string;
  entryCount: number;
  skippedDuplicates: number;
  warnings: string[];
  entries: number;
  booked: number;
  ignored: number;
  unhandled: number;
}
export interface BankFileMeta {
  id: string;
  filename: string;
  sha256: string;
  bankMessageId: string | null;
  bankCreatedAt: string | null;
  entryCount: number;
  skippedDuplicates: number;
  warnings: string[];
  createdAt: string;
}
// GET /bank-files/:id — the notification accounts (Ntfctn/Acct) and, when one
// is none of the company's, the warning to show.
export interface BankFileDetail extends BankFileMeta {
  accounts: string[];
  accountWarning: string | null;
}
export interface BankFileSkippedFrom {
  bankFileId: string;
  filename: string;
  count: number;
}
export interface OutgoingEntryView {
  id: string;
  position: number;
  direction: "credit" | "debit";
  reversal: boolean;
  amount: number;
  currency: string;
  bookingDate: string;
  endToEndId: string | null;
  counterpartyName: string | null;
  returnReason: string | null;
  state: "booked" | "ignored" | "matched" | "return" | "amount_mismatch" | "already_confirmed" | "not_waiting" | "unknown";
  item: {
    id: string;
    batchId: string;
    batchNumber: string;
    endToEndId: string;
    status: string;
    amount: number;
    registrationNumber: string;
    paymentId: string | null;
    paymentNumber: string | null;
  } | null;
  payment: { id: string; paymentNumber: string } | null;
  ignoreReason: string | null;
}

// Bankfiler: GET /bank-files/:id/incoming (bank-file.service.ts incomingView).
export interface IncomingProposalRow {
  invoiceId: string;
  invoiceNumber: string;
  openAmount: number;
  appliedAmount: number;
}
export interface IncomingProposal {
  entryId: string;
  state: "matched" | "suggested" | "unmatched";
  basis: "ocr" | "amount_name" | "amount_only" | "name_allocation" | null;
  reason: string | null;
  partial: boolean;
  customerId: string | null;
  customerName: string | null;
  rows: IncomingProposalRow[];
  alternatives: { invoiceId: string; invoiceNumber: string; customerId: string; customerName: string; openAmount: number; dueDate: string | null }[];
}
export interface IncomingEntryView {
  id: string;
  position: number;
  amount: number;
  currency: string;
  bookingDate: string;
  counterpartyName: string | null;
  remittance: { type: string; value: string; amount: number | null }[];
  warning: string | null;
  state: "booked" | "ignored" | "not_sek" | "matched" | "suggested" | "unmatched";
  proposal: IncomingProposal | null;
  payment: { id: string; paymentNumber: string } | null;
  ignoreReason: string | null;
}

// System → Exempeldata (GET/POST /api/v1/demo-data).
export type DemoDataBlocker = "articles" | "customers" | "suppliers" | "workCenters";

export interface DemoDataStatus {
  available: boolean;
  blockers: DemoDataBlocker[];
}

export interface DemoDataCreated {
  created: { articles: number; workCenters: number; customers: number; suppliers: number; stockTransactions: number };
}

// System → Kom igång (GET /api/v1/onboarding).
export interface OnboardingStepView {
  key: string;
  title: string;
  description: string;
  done: boolean;
  links: { href: string; label: string }[];
}

export interface OnboardingView {
  groups: { title: string; steps: OnboardingStepView[] }[];
  done: number;
  total: number;
  complete: boolean;
}

// Terminal operation list (GET /terminal/stations, /terminal/operations).
export interface TerminalStation {
  id: string;
  code: string;
  name: string;
}

export interface TerminalMaterial {
  articleId: string;
  articleNumber: string;
  articleName: string;
}

export type TerminalReadiness = "ready" | "partial" | "not_ready";

export interface TerminalOperation {
  operationId: string;
  manufacturingOrderId: string;
  orderNumber: string;
  articleNumber: string;
  articleName: string;
  sequenceNo: number;
  description: string | null;
  workCenterId: string;
  workCenterCode: string;
  workCenterName: string;
  orderQuantity: string;
  quantityCompleted: string | null;
  quantityScrapped: string;
  dueDate: string | null;
  readiness: TerminalReadiness;
  available: string;
  materials: TerminalMaterial[];
  packingInstructions: string | null;
}

// GET /supplier-delivery-date-suggestion and /customer-delivery-date-suggestion
// (fasta leveransdagar). The texts are ready-made by the API; the web shows
// them as they are and never computes dates itself.
export interface DeliveryDateSuggestion {
  date: string | null;
  summary: string | null;
  warning: string | null;
}

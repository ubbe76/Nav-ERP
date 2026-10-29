import type { ManufacturingOrderConfiguration, OrderRowConfiguration } from "./configurator";
import type { DocumentRateSourceValue } from "./currency";
import type { Permission } from "./permissions";
import type { VatBoxSetting, VatDeclarationBoxes, VatReportingPeriod } from "./vatBoxes";
import type {
  BuyerVatNumberProblem,
  BuyerVatNumberWarning,
  CustomerVatNumberWarning,
  CustomerVatTreatment,
  VatCode,
  VatCodeRef,
  VatCodeSlot,
} from "./vatCodes";
import type { FixedAssetDisposalType, FixedAssetStatus } from "./fixedAssets";
import type { YearEndAccrualKind, YearEndRole, YearEndStep } from "./yearEnd";
import type { ThemeContrastFailure, ThemeIssue, ThemeScheme, ThemeSource, ThemeValidationResult } from "./themeCore";
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
  // VAT rate (moms) for sales/invoice rows — derived from the varugrupp
  // (25 % without one), read-only on the article.
  vatRate: string;
  // Nettovikt (kg) and dimensions (mm).
  weight: string | null;
  length: string | null;
  width: string | null;
  height: string | null;
  // Surface treatment (ytbehandling) and colour (färg) — free text.
  surfaceTreatment: string | null;
  colour: string | null;
  // Extra benämning — multi-line free text (max 2 000 characters), printed
  // under the article name on the documents chosen in the system settings.
  extraDescription: string | null;
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
  // Only on GET :id.
  groupCode?: string | null;
  // Artikelkod (Grunddata register): selection/grouping concept in lists.
  articleCodeId: string | null;
  articleCodeCode: string | null;
  articleCodeName: string | null;
  // Default stock location — transactions without an explicit location land
  // here (null = the auto-created "***" location). Names only on GET :id.
  defaultLocationId: string | null;
  defaultLocationName?: string | null;
  defaultWarehouseName?: string | null;
  // Behovsberäkning (MRP light, E1): compared against projected stock and
  // used to round proposal quantities up to the nearest multiple.
  reorderPoint: string | null;
  // Säkerhetslager (base unit): the proposal floor is the larger of
  // reorderPoint and safetyStock. Null = none.
  safetyStock: string | null;
  // Styrning: true = Lagerstyrd, false = Orderstyrd. Information only.
  stockControlled: boolean;
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
  // 1–4 digits.
  code: string;
  name: string;
  description: string | null;
  // null = the default article number series.
  numberSeriesKey: string | null;
  // VAT rate (moms) every article in the group gets, e.g. "25.00".
  vatRate: string;
  // Kostnadsställe (förval) for the revenue/cost rows of this group's articles.
  defaultCostCenterId?: string | null;
  createdAt: string;
}

// An article number series as offered when creating articles / groups.
export interface ArticleNumberSeriesOption {
  key: string;
  name: string | null;
  prefix: string;
  isDefault: boolean;
  // The number a new article would get right now (a preview).
  nextArticleNumber: string;
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
  // "Pos." — free-text drawing position (max 20), null when not set.
  position: string | null;
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
  // The bucket's id — a varugrupp or an artikelkod depending on groupBy.
  groupId: string | null;
  groupName: string;
  rows: ValuationRow[];
  // Excludes rows with value === null.
  total: number;
}

export interface ValuationResponse {
  asOf: string;
  method: ValuationMethod;
  // What groups[] are: varugrupper or artikelkoder.
  groupBy: "group" | "articleCode";
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
  // + dL (laborCost)
  // + Lego (subcontractCost) + LO (subcontractOverhead)
  // + Halvfabrikat (semiFinishedCost — no markup of its own)
  // = TVK, + Affo (businessOverhead) = SVK,
  // + generalMarkup + TO (overhead, per work center) = salesPrice.
  // TO is outside TVK and SVK. TVK and SVK are plain sums, derived on display.
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
  // Materialpåslag on dM + MO (plus the halvfabrikats' lifted up) — outside
  // TVK/SVK, towards the sales price only. "0.0000" on every calculation saved
  // before the markup existed.
  materialMarkup: string;
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
  materialMarkupPercent: string;
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
  // TO lifted up from a halvfabrikat's own calculation ("semi" rows); "0.0000"
  // on other rows and on rows saved before the column existed.
  overheadAmount: string;
  // Materialpåslag lifted up the same way; "0.0000" otherwise.
  materialMarkupAmount: string;
  // A supplier price in another currency: the catalog price, its currency
  // and the rate unitCost was converted at. All null otherwise, and on rows
  // saved before the conversion existed.
  supplierCurrency: string | null;
  supplierUnitPrice: string | null;
  exchangeRate: string | null;
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
  // Förlustorsaker and Kvalitetsorsaker only — absent on the other registers.
  active?: boolean;
  // Kvalitetsorsaker only: which cases (and the kassation) the reason applies to.
  appliesCustomer?: boolean;
  appliesSupplier?: boolean;
  appliesInternal?: boolean;
  appliesScrap?: boolean;
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
  // blocksReplacement (the dimension registers): the reference cannot be
  // moved to a replacement — booked verification rows, locked documents —
  // so the entry can only be deactivated.
  references: { table: string; label: string; labelOne: string; count: number; blocksReplacement?: boolean }[];
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
  // Momskoder: the supplier's own country (ISO-2, default "SE") and its own
  // Momskod (förval); null = derived from the country. `defaultVatCode` is
  // the effective code ({ ..., derived: true } when it is the derived one) —
  // on the detail/PATCH answers only, not in the list rows.
  country: string;
  defaultVatCodeId: string | null;
  // Kostnadsställe (förval) on the supplier's invoice rows.
  defaultCostCenterId?: string | null;
  defaultVatCode?: (VatCodeRef & { derived: boolean }) | null;
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
  confirmedDeliveryDate: string | null;
  // List-only: earliest effective delivery date among open rows.
  nextDeliveryDate?: string | null;
  note: string | null;
  // "Frakt på vårt konto" — prints our carrier customer number on the PO.
  freightPaidByUs: boolean;
  // Er referens (leverantörens referens) / Vår referens (vår inköpare).
  yourReference: string | null;
  ourReference: string | null;
  // Projekt: follows along when the order is the basis of a supplier invoice.
  projectId?: string | null;
  project?: DimensionRef | null;
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
  confirmedDeliveryDate: string | null;
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

// --- Valutakurser (Ekonomi → Valutakurser) ---

// Where a stored rate came from: fetched from Sveriges Riksbank or typed in.
export type ExchangeRateSourceValue = "riksbank" | "manual";

// GET /exchange-rates/list row.
export interface ExchangeRateEntry {
  id: string;
  currency: string;
  date: string;
  // SEK per 1 unit of the currency.
  rate: number;
  source: ExchangeRateSourceValue;
  createdBy: string | null;
  createdByName: string | null;
  createdAt: string;
  updatedAt: string;
}

// GET /exchange-rates?currency&date — the rate for the day: the latest banking
// day ≤ requestedDate. SEK ⇒ rate 1 and source null. 409
// exchange-rate-unavailable when there is none.
export interface ExchangeRateLookup {
  currency: string;
  requestedDate: string;
  date: string;
  rate: number;
  source: ExchangeRateSourceValue | null;
}

// POST /exchange-rates/fetch (Hämta från Riksbanken).
export interface ExchangeRateFetchResult {
  currency: string;
  from: string;
  to: string;
  fetched: number;
  // The Riksbank days in the interval, oldest first (exchange-rates.ts's
  // StoredRate — no id/audit columns, unlike the register list's rows).
  rates: { date: string; rate: number; source: ExchangeRateSourceValue }[];
}

// GET/PATCH /exchange-rate-settings (admin). The API key is write-only.
export interface ExchangeRateSettings {
  source: "riksbank" | "manual";
  apiKeySet: boolean;
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
  // Momskoder: the header's code (every row without a code of its own and the
  // remainder follow it). Not in the list rows' joins, so optional here.
  vatCodeId?: string;
  // Kostnadsställe/Projekt: the default for rows without their own (default
  // from the supplier's cost centre, else the article group's; the project
  // follows the purchase order).
  costCenterId?: string | null;
  projectId?: string | null;
  costCenter?: DimensionRef | null;
  project?: DimensionRef | null;
  // Valuta: SEK per 1 unit of `currency` (numeric string, 1 for SEK), where it
  // came from (null for SEK) and the day of a looked-up rate, and the debt in
  // SEK stamped at attest (null in a draft).
  exchangeRate: string;
  exchangeRateSource: DocumentRateSourceValue | null;
  exchangeRateDate: string | null;
  grossAmountSek: string | null;
  // Only on the list rows: the invoice's SEK value — the stamped debt, else
  // gross × rate; null for a foreign draft that has no rate yet.
  grossSekValue?: string | null;
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
  // Momskoder: the row's own code; null = follows the invoice's.
  vatCodeId: string | null;
  vatCode: VatCodeRef | null;
  // null = follows the invoice's Kostnadsställe/Projekt.
  costCenterId?: string | null;
  projectId?: string | null;
  costCenter?: DimensionRef | null;
  project?: DimensionRef | null;
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
// Förhandsvisning av beräknad (omvänd) moms — what approving books as both
// utgående and ingående moms, per omvänd momskod. In SEK (the base is the
// invoice's SEK net at its rate, exactly as the poster books it).
export interface SupplierInvoiceReverseVat {
  code: VatCode;
  base: number;
  vat: number;
}

export interface SupplierInvoiceDetail extends SupplierInvoice {
  vatCodeId: string;
  vatCode: VatCodeRef;
  reverseVat: SupplierInvoiceReverseVat[];
  // Never a refusal: a domestic code with VAT but no Momsbelopp, a supplier
  // with another currency than SEK but land Sverige (supplierInvoiceWarnings).
  warnings: string[];
  rows: SupplierInvoiceRow[];
  openAmount: number;
  // Valuta: the open amount's booked SEK value (null until attested), the
  // header in SEK at the invoice's rate (a draft's preview; after the attest
  // the amounts that were booked) and "kurs saknas" for a foreign invoice
  // that never got a rate.
  openAmountSek: number | null;
  sekAmounts: { grossAmount: number; vatAmount: number; netAmount: number };
  exchangeRateMissing: boolean;
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
  // Valuta: grossAmount/openAmount are in `currency`; exchangeRate is the
  // invoice's, grossAmountSek the debt booked at attest and openAmountSek what
  // is left of it (both null before the attest stamped it).
  currency: string;
  exchangeRate: number;
  grossAmountSek: number | null;
  openAmountSek: number | null;
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
  // In `currency` (the invoices' — one payment never mixes currencies).
  amount: string;
  // Valuta: the SEK that left the bank account (= amount for a SEK payment)
  // and the bank's fee in SEK (part of amountSek).
  currency: string;
  amountSek: string;
  bankFeeSek: string;
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
  // Valuta: the SEK each part released from the invoice's booked debt
  // (frigjort SEK) and the invoice's own rate.
  appliedAmountSek: string;
  writeOffAmountSek: string;
  invoiceExchangeRate: string;
  createdAt: string;
  registrationNumber: string;
  invoiceNumber: string;
  invoiceDueDate: string | null;
}

// GET /supplier-payments/:id — header plus its rows.
export interface SupplierPaymentDetail extends SupplierPaymentHeader {
  // Valuta: positive = kursvinst, negative = kursförlust (0 for SEK).
  exchangeRateDifferenceSek: number;
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
  // Valuta: the payment's currency (= the invoice's) and the SEK the row
  // released from the invoice's debt.
  currency: string;
  appliedAmountSek: string;
  writeOffAmountSek: string;
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
  // Faktura i vänteläge: the customer's invoices are reviewed before they go
  // out — Samlingsfakturering's "Utfärda direkt" leaves them as drafts.
  invoiceOnHold: boolean;
  // Frakt etapp 2: kundens förvalda fraktprodukt (nya försändelser ärver den).
  // The id is a column (always returned); the joined names are present on
  // the detail endpoint (GET :id) only, like the term/carrier names above.
  defaultFreightProductId: string | null;
  defaultFreightCarrierName?: string | null;
  defaultFreightProductName?: string | null;
  // Privatperson — styr etiketten Personnummer/Organisationsnummer på
  // Villkor & frakt.
  privatePerson: boolean;
  // Omvänd betalningsskyldighet för byggtjänster (momskoder): a service row to
  // this Swedish customer gets the momskod OB.
  reverseChargeConstruction: boolean;
  // Momsbehandling — derived by the API (customerVatTreatment); on the detail
  // and PATCH answers, not in the list rows.
  vatTreatment?: CustomerVatTreatment;
  // What the card says about the momsnummer of an EU company customer
  // (customerVatNumberWarning) — on the same answers as vatTreatment.
  vatNumberWarning?: CustomerVatNumberWarning | null;
  // Visa tilläggspriser — förval för konfigurerade raders pristillägg på
  // offert/orderbekräftelse (och vad fakturan följer).
  showConfigurationPrices: boolean;
  // Kod på pallkort — null = följ systeminställningen.
  palletCardCode: PalletCardCode | null;
  website: string | null;
  // E-faktura (Peppol): hur kunden vill ha sina fakturor, och kundens
  // Peppol-id ("0007:5560000000"; null = härleds ur organisationsnumret).
  invoiceDelivery: "email" | "peppol";
  peppolId: string | null;
  // Valuta: the customer's currency (ISO 4217, "SEK" by default). New quotes
  // and orders take it with today's rate; the customer's särpriser are in it.
  currency: string;
  // Dröjsmålsränta (Försäljning → Räntefakturering): whether late interest is
  // charged on the customer's overdue invoices (förval ja), the Avtalad
  // räntesats (total %, numeric(5,2) so it may arrive as a string; null =
  // enligt räntelagen: referensränta + räntemarginal) and whether
  // förseningsersättning is charged (ignored for a privatperson).
  lateInterest: boolean;
  lateInterestRate: string | number | null;
  lateFee: boolean;
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
  // Valuta: the list's prices are in this currency; the price chain only uses
  // a list in the order's own currency.
  currency: string;
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
  currency: string;
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
  // Ställpris: one-off charge (rule currency) added as its own Ställkostnad
  // row on new order rows; null = none.
  setupPrice: string | null;
}

// One customer article number (kundkortets flik Kundens artikelnummer) — a row
// from GET /customers/:id/article-numbers: what the customer calls one of our
// articles. One per customer and article; the article never changes on an
// update (remove and add instead).
export interface CustomerArticleNumber {
  id: string;
  articleId: string;
  articleNumber: string;
  articleName: string;
  customerArticleNumber: string;
}

export type SalesOrderStatus =
  | "quote"
  | "confirmed"
  | "in_production"
  | "delivered"
  | "invoiced"
  | "cancelled"
  | "lost";

export const SALES_ORDER_STATUS_PILL: Record<SalesOrderStatus, { status: "running" | "delayed" | "stopped" | "done" | "draft"; label: string }> = {
  quote: { status: "draft", label: "Offert" },
  confirmed: { status: "running", label: "Bekräftad" },
  in_production: { status: "running", label: "Under tillverkning" },
  delivered: { status: "done", label: "Levererad" },
  invoiced: { status: "draft", label: "Fakturerad" },
  cancelled: { status: "stopped", label: "Avbruten" },
  lost: { status: "stopped", label: "Förlorad" },
};

export interface SalesOrder extends DocumentTermsFields {
  id: string;
  orderNumber: string;
  // Offerter: OF-… number kept after the quote becomes an order (null for
  // direct orders and older quotes); documentKind is derived by the API.
  quoteNumber?: string | null;
  documentKind?: "quote" | "order";
  customerId: string;
  customerName: string;
  status: SalesOrderStatus;
  // Valuta: the order's currency and its rate (SEK per 1 unit, a numeric
  // string with six decimals; "1" for SEK). Snapshotted at creation from the
  // customer and today's rate; prices on the order are in `currency`.
  currency: string;
  exchangeRate: string;
  // List-only: earliest effective delivery date among open rows.
  nextDeliveryDate?: string | null;
  expectedDeliveryDate: string | null;
  // Offertuppföljning: created as a quote (not a direct order), Giltig t.o.m.
  // and the loss registration (status lost).
  quoted?: boolean;
  quoteValidUntil?: string | null;
  lostReasonId?: string | null;
  lostReasonCode?: string | null;
  lostReasonName?: string | null;
  lostNote?: string | null;
  lostAt?: string | null;
  lostBy?: string | null;
  lostByName?: string | null;
  note: string | null;
  customerOrderNumber: string | null;
  // Kundens förfrågan — the customer's inquiry/RFQ reference (0139).
  customerInquiryNumber: string | null;
  customerReference: string | null;
  // Kostnadsställe/Projekt: the default for the order's invoice rows.
  costCenterId?: string | null;
  projectId?: string | null;
  costCenter?: DimensionRef | null;
  project?: DimensionRef | null;
  deliveryAddressId: string | null;
  // Joined from the selected delivery address (detail endpoint only).
  deliveryAddressLabel?: string | null;
  deliveryAddress?: string | null;
  deliveryPostalCode?: string | null;
  deliveryCity?: string | null;
  // The address is an engångsadress typed in on this order (not one of the
  // customer's saved addresses).
  deliveryAddressOneOff?: boolean | null;
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
  // elsewhere — matches the API response). Valuta: orders in another currency
  // are converted at their order's rate.
  netAmount: number;
  // Valuta: the currencies the run will invoice this customer in — one invoice
  // per currency (SEK first, then alphabetically).
  currencies: string[];
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
  // Valuta: one result row per customer and currency (absent on a result for
  // a customer that could not be read).
  currency?: string;
  // Faktura i vänteläge: "Utfärda direkt" left the draft because the customer
  // is on hold (status stays "draft"). Absent otherwise.
  onHold?: boolean;
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
  expectedDeliveryDate: string | null;
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
  // Ställkostnad: set on the automatically added charge row — the id of the
  // article row it belongs to (null for an ordinary row).
  setupForRowId: string | null;
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
//
// Valuta: the quote is in the order's currency (salesOrderId, or the currency/
// exchangeRate asked for, else the customer's with today's rate) and says which.
export interface PriceQuote {
  articleNumber: string;
  price: { unitPrice: number; discountPercent: number; source: string } | null;
  currency?: string;
  exchangeRate?: number;
}

// Leveranstillfälle (delivery occasion) — C2. One row per utleverans event;
// GET /sales-orders/:id/deliveries returns these newest first for the order
// card's "Följesedlar" history.
export interface SalesDelivery {
  id: string;
  deliveryNumber: string;
  deliveredAt: string;
  rowCount: number;
  // Rows undone by Ångra utleverans; undoneRowCount === rowCount ⇒ the whole följesedel is Ångrad.
  undoneRowCount: number;
  // Frakt: the live (non-cancelled) shipment of this följesedel, if any.
  shipment: DeliveryShipmentInfo | null;
}

// GET /deliveries/:id/rows — quantities already in the row's unit.
export interface DeliveryRowsResponse {
  deliveryNumber: string;
  rows: {
    id: string;
    articleNumber: string;
    articleName: string;
    quantity: number;
    unit: string;
    undoneAt: string | null;
    undoneByName: string | null;
    undoable: boolean;
  }[];
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
  // Valuta: SEK per 1 unit of `currency` (numeric string; "1" for SEK, null on
  // a foreign draft until Utfärda stamps the invoice date's rate — or a rate
  // typed in on the draft, exchangeRateManual). The receivable in SEK is
  // stamped at Utfärda (null on a draft).
  exchangeRate: string | null;
  exchangeRateManual: boolean;
  grossAmountSek: string | null;
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
  // E-faktura: status of the latest Peppol transmission (null = none sent) —
  // a production transmission before any sandbox one, whichever is newer.
  einvoiceStatus: "sending" | "sent" | "delivered" | "rejected" | "failed" | null;
  einvoiceEnvironment: "sandbox" | "production" | null;
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
  // The rate is a snapshot of the code's rate — the momskod is what decides.
  vatRate: string;
  // Momskoder: the row's code (name as the company calls it, invoiceText the
  // text the PDF prints under the VAT summary).
  vatCodeId: string;
  vatCode: VatCodeRef & { invoiceText: string | null };
  // Leveransdatum (ML 17 kap. 24 § p. 7) — null = not stated.
  deliveryDate: string | null;
  lineAmount: string;
  vatAmount: string;
  createdAt: string;
  articleNumber: string | null;
  articleName: string | null;
  salesOrderNumber: string | null;
  // Konfigurator 4b: copy of the order row's configuration (null for a
  // free/plain row), printed as choice lines on the invoice PDF.
  configuration: OrderRowConfiguration | null;
  // Kostnadsställe/Projekt on the revenue row (default from the order, else
  // the article group's cost centre).
  costCenterId?: string | null;
  projectId?: string | null;
  costCenter?: DimensionRef | null;
  project?: DimensionRef | null;
  // Dröjsmålsränta: the account the row books against, set by Räntefakturering
  // on an interest invoice's rows (8313 / 3990) — wins over the konteringsregel
  // and the momskod's account. null on every other row.
  revenueAccount?: string | null;
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
  // Valuta: the SEK the row released from the invoice's booked receivable
  // (frigjort SEK, numbers — equal to the amounts for a SEK invoice).
  appliedAmountSek: number;
  writeOffAmountSek: number;
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
  // Köparens momsregistreringsnummer as the invoice shows it — on a draft the
  // number Utfärda would stamp (the customer's current one; a credit note's
  // source invoice's), the issue snapshot afterwards.
  buyerVatNumber: string | null;
  // Drafts only: what Utfärda would refuse (null = in order, always null once
  // issued) — so the card can warn ahead of it.
  vatNumberProblem: BuyerVatNumberProblem | null;
  // Drafts only: an EU sale whose number belongs to another member state than
  // the customer's country — allowed, worth a second look. Null when there is
  // a problem (the refusal comes first).
  vatNumberWarning: BuyerVatNumberWarning | null;
  openAmount: number;
  // Valuta: the SEK figures at the invoice's rate (a draft's preview, the
  // booked figures once issued; positive like the rows — the sign is `type`).
  // null for a foreign draft without a rate yet. openAmountSek is the open
  // amount's booked SEK value (null until issued).
  sekAmounts: { grossAmount: number; vatAmount: number; netAmount: number } | null;
  openAmountSek: number | null;
  payments: InvoicePaymentEntry[];
  reminders: InvoiceReminderEntry[];
  // Reverse of creditedInvoiceId — every non-cancelled credit note that
  // targets this invoice. invoiceNumber is null for a still-draft credit;
  // the card labels that "Utkast" rather than hiding the link.
  creditedBy: { id: string; invoiceNumber: string | null }[];
  // Dröjsmålsränta: what Räntefakturering has charged on this (source) invoice
  // and whether this invoice is itself a räntefaktura. `active` is derived by
  // the API: false when the räntefaktura is cancelled or fully credited.
  lateInterestCharges?: InvoiceLateInterestCharge[];
  isLateInterestInvoice?: boolean;
}

export interface InvoiceLateInterestCharge {
  id: string;
  // null on a pure förseningsersättning row.
  fromDate: string | null;
  toDate: string | null;
  days: number;
  amount: string | number;
  fee: string | number;
  chargeInvoiceId: string;
  chargeInvoiceNumber: string | null;
  active: boolean;
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
  // Momskoder: the code the row gets for this customer (null only if the
  // code is missing from the company's list).
  vatCodeId: string | null;
  vatCode: VatCodeRef | null;
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
  // Kundpriset in SEK (Sendify's price plus the markup). Valuta: unitPrice is
  // the same price in `currency` — the currency of the order the shipment's
  // first följesedel belongs to (SEK when none can be found), converted at that
  // order's rate; null when no rate exists for the currency (the shipment
  // cannot be billed until one does).
  customerPrice: string;
  currency: string;
  unitPrice: number | null;
  bookedAt: string | null;
  deliveryNumbers: string[];
  articleId: string;
  articleNumber: string;
  articleName: string;
  vatRate: string;
  // Momskoder: freight follows the goods.
  vatCodeId: string | null;
  vatCode: VatCodeRef | null;
  description: string;
}

// GET /invoiceable-orders?customerId= — delivered/in_production/invoiced
// orders with rows that still have an un-invoiced delivered quantity,
// grouped per order. Draft-invoice basis for the create dialog.
export interface InvoiceableOrder {
  orderId: string;
  orderNumber: string;
  // Valuta: the order's currency and rate — an invoice takes one currency, the
  // dialog groups on it. unitPrice on the rows is in this currency.
  currency: string;
  exchangeRate: string;
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
  // Valuta: grossAmount/openAmount are in `currency`; exchangeRate is the
  // invoice's (null on a draft-like row), grossAmountSek the receivable booked
  // at Utfärda and openAmountSek what is left of it (signed like the amounts).
  // The OCR lookup returns the same shape as the list.
  currency: string;
  exchangeRate: number | null;
  grossAmountSek: number | null;
  openAmountSek: number | null;
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
  // In `currency` (the invoices' — one payment never mixes currencies).
  amount: string;
  // Valuta: the SEK that reached the bank account (= amount for a SEK payment;
  // for a refund what left it) and the bank's fee in SEK.
  currency: string;
  amountSek: string;
  bankFeeSek: string;
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
  // Valuta: the SEK each part released from the invoice's booked receivable
  // (frigjort SEK) and the invoice's own rate.
  appliedAmountSek: string;
  writeOffAmountSek: string;
  invoiceExchangeRate: string | null;
  createdAt: string;
  invoiceNumber: string | null;
  invoiceType: InvoiceType;
  invoiceDueDate: string | null;
}

// GET /payments/:id — header plus its rows.
export interface PaymentDetail extends PaymentHeader {
  // Valuta: positive = kursvinst, negative = kursförlust (0 for SEK).
  exchangeRateDifferenceSek: number;
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
  // Kapacitet (timmar per dag): Monday–Friday hours used when the resource
  // has no week schedule (the schedule wins when both are set). null = none.
  hoursPerDay: string | null;
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
  calcRate2: string | null;
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
  // "Cykeltid" — the operation's productive time, minutes per unit like
  // runTimePerUnit and shown in the same timeUnit. null = not set.
  cycleTimePerUnit: string | null;
  // Display preference for runTimePerUnit (and cycleTimePerUnit) — always
  // stored/returned in minutes per unit regardless of this value; conversion
  // happens at the edges (OperationModal, BeredningView) via lib/units.ts.
  timeUnit: "minutes_per_unit" | "units_per_hour" | "seconds_per_unit";
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
  // Transportkostnad — freight to and from the subcontractor, one-off per
  // order; added to the ställpris wherever the lego one-off is used.
  transportPrice: string | null;
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
  // The article's base unit (MO quantities are base-unit); only on the
  // detail GET, not in the list.
  articleUnitCode?: string;
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
  // Produktionsplanering — on list rows and the single GET: min/max planned
  // week (Mondays) over the pending operations, null = unplanned; late = Sen.
  plannedStartWeek?: string | null;
  plannedEndWeek?: string | null;
  late?: boolean;
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
  // The operation's whole remaining time; hoursInWeek is the share this cell
  // carries (a multi-week operation appears in one cell per planned week).
  remainingHours: number;
  moOperationId: string;
  hoursInWeek: number;
  // Produktionsplanering: false = unplanned (counted in the due-date week).
  planned: boolean;
  // Mondays (YYYY-MM-DD); null when unplanned.
  plannedStartWeek: string | null;
  plannedEndWeek: string | null;
  // Moved by hand — Planera leaves it where it is until Lås upp.
  planLocked: boolean;
  // Planned finish is after the order's due date (Sen).
  late: boolean;
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

export interface CapacitySummary {
  // max(planned_at) over the operations; null = never planned.
  plannedAt: string | null;
  overloadedCells: number;
  lateOrders: { manufacturingOrderId: string; orderNumber: string; dueDate: string; plannedFinish: string | null }[];
  unplannedOrders: { manufacturingOrderId: string; orderNumber: string }[];
}

export interface CapacityResult {
  weeks: CapacityWeek[];
  groups: CapacityGroupBlock[];
  summary: CapacitySummary;
}

// Produktionsplanering: warning from Planera / Flytta / a new order's plan.
export interface PlanWarning {
  kind: "late" | "horizon" | "sequence" | "unscheduled_resource" | "long_operation";
  manufacturingOrderId: string;
  orderNumber: string;
  sequenceNo?: number;
  workCenterCode?: string;
  dueDate?: string;
  plannedFinish?: string;
  remainingHours?: number; // long_operation: the operation's remaining time
  message: string;
}

// POST /planning/plan.
export interface PlanResult {
  plannedAt: string;
  orders: number;
  operations: number;
  warnings: PlanWarning[];
}

// POST /planning/operations/:opId/move.
export interface MoveOperationResult {
  operation: { plannedStartWeek: string | null; plannedEndWeek: string | null; planLocked: boolean };
  following: { moOperationId: string; sequenceNo: number; plannedStartWeek: string | null; plannedEndWeek: string | null }[];
  warnings: PlanWarning[];
}

// POST /planning/operations/:opId/unlock.
export interface UnlockOperationResult {
  operation: { plannedStartWeek: string | null; plannedEndWeek: string | null; planLocked: boolean };
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

// Ändra material och operationer på en skapad TO — the API answers with the
// saved row plus warnings (shortage, planning), never blocking.
export interface MOMaterialSaveResult {
  material: MOMaterialConsumption;
  warnings: string[];
}

export interface MOOperationSaveResult {
  operation: MOOperation;
  warnings: string[];
}

export interface MOOperationDeleteResult {
  warnings: string[];
  // Material rows that were tied to the removed operation and are now drawn at receipt.
  unlinkedMaterials: number;
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
  timeUnit: "minutes_per_unit" | "units_per_hour" | "seconds_per_unit";
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
  // Transportkostnad — freight to and from the subcontractor, one-off per
  // order; added to the ställpris wherever the lego one-off is used.
  transportPrice: string | null;
  showNetWeight: boolean;
  // Produktionsplanering: planned weeks (Mondays), null = unplanned. A locked
  // plan was moved by hand and stays put through Planera.
  plannedStartWeek: string | null;
  plannedEndWeek: string | null;
  planLocked: boolean;
  plannedAt: string | null;
  createdAt: string;
}

// One scrap report on an operation (GET /manufacturing-orders/:id/scrap).
export interface ScrapEntry {
  id: string;
  moOperationId: string;
  sequenceNo: number;
  workCenterName: string;
  quantity: string;
  // Orsak from Kvalitetsorsaker (null on older rows, which keep their free text).
  reasonId: string | null;
  reasonCode: string | null;
  reasonName: string | null;
  // The comment, or the older free-text reason (null when there is none).
  reason: string | null;
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
  // Minutes; null = no balancing.
  ordinaryMinutesPerWeek: number | null;
  atfMinutesPerWeek: number;
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
    // The day schedule's own values (endTime/netMinutes are the computed ones).
    scheduleEndTime?: string;
    scheduleNetMinutes?: number;
    breaks: { type: "unpaid" | "paid"; startTime: string; endTime: string }[];
  } | null;
  // Set on a balanced week's last workday (a sibling of daySchedule).
  balance?: {
    workdays: number;
    normalWorkdays: number;
    weekAtfMinutes: number;
    lostAtfMinutes: number;
  };
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
  // Avvikelseorsaker on the stamps (late start / early stop).
  startReasonId: string | null;
  startNote: string | null;
  stopReasonId: string | null;
  stopNote: string | null;
}

// 409 attendance-input-required from Stämpla in närvaro, Stämpla in (when it
// opens the attendance) and Gå hem — the questions the terminal must ask
// before sending the request again. Either or both can be set.
export interface AttendanceInputRequiredBody {
  error: string;
  code: "attendance-input-required";
  reason: { kind: "late" | "early"; minutes: number; scheduledTime: string } | null;
  overtime: { minutes: number; offSchedule: boolean; current: OvertimeCompensation } | null;
}

// The answers: `reason` on POST /attendance-sessions, `attendanceReason` on
// POST /stamp-sessions, and this body on POST /attendance-sessions/:id/stop.
export interface AttendanceReasonInput {
  reasonId: string;
  note?: string;
}
export interface AttendanceOutInput {
  reason?: AttendanceReasonInput;
  overtimeDisposition?: OvertimeCompensation;
  atfTransactionId?: string;
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

// Mirrors EXTRA_DESCRIPTION_DOCUMENTS in packages/shared/src/system.ts — the
// web cannot import @navet/shared. Same ids in the same (canonical) order.
export const EXTRA_DESCRIPTION_DOCUMENT_LABELS = {
  inquiry: "Förfrågan",
  purchaseOrder: "Inköpsorder",
  quote: "Offert",
  orderConfirmation: "Orderbekräftelse",
  pickList: "Plocklista",
  deliveryNote: "Följesedel",
  invoice: "Faktura",
  manufacturingOrder: "Tillverkningsorder",
} as const;
export type ExtraDescriptionDocument = keyof typeof EXTRA_DESCRIPTION_DOCUMENT_LABELS;
export const EXTRA_DESCRIPTION_DOCUMENTS = Object.keys(
  EXTRA_DESCRIPTION_DOCUMENT_LABELS
) as ExtraDescriptionDocument[];

export interface SystemSettings {
  // Egna teman: the company's default theme (a built-in id or a custom
  // theme's key) and whether users may pick their own.
  defaultTheme: string;
  themeChoiceLocked: boolean;
  allowMultipleStamps: boolean;
  // Print active article/drawing revisions per row on external documents.
  showRevisionsOnDocuments: boolean;
  // Documents that print the article's Extra benämning under the name, in
  // EXTRA_DESCRIPTION_DOCUMENTS order (empty = none).
  extraDescriptionDocuments: ExtraDescriptionDocument[];
  // Print the order's own revision after the document number
  // ("Inköpsorder IO2500123 / 2") on offert/orderbekräftelse/inköpsorder.
  showOrderRevisionOnDocuments: boolean;
  // Company-wide ATF accrual in minutes per completed work week (0 = off);
  // individual employees can override it on the personalkort.
  atfMinutesPerWeek: number;
  // Week schedules may carry ordinary hours + ATF per week (balancing).
  scheduleBalancing: boolean;
  // Daily overtime grace period in minutes (löneunderlag) — worked time past
  // schedule must exceed this before it counts as overtime.
  payrollOvertimeThresholdMinutes: number;
  // Stamp terminal: require a reason for a late arrival / early departure
  // beyond the tolerance, and ask about overtime compensation on Gå hem.
  attendanceReasonRequired: boolean;
  attendanceReasonToleranceMinutes: number;
  terminalOvertimeChoice: boolean;
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
  // Kod på pallkort: none = inga koder, barcode = Code 128, qr = QR-kod.
  palletCardCode: PalletCardCode;
  // Tillåt utskrift av pallkort även om kollina inte stämmer med totalt antal.
  palletCardAllowQuantityMismatch: boolean;
  // Orimligt mycket tid (Planera, ny TO): weeks of a resource's capacity one
  // operation may fill before the planner warns; 0 = no warning.
  planningLongOperationWeeks: number;
  supplierDeliveryDayMode: DeliveryDayMode;
  supplierTransitDays: number;
  customerDeliveryDayMode: DeliveryDayMode;
  customerTransitDays: number;
  costingMoPercent: number;
  costingLoPercent: number;
  costingAffoPercent: number;
  costingGeneralMarkupPercent: number;
  costingMaterialMarkupPercent: number;
  // Tillåten överleverans på inköpsorder, percent of the row's ordered
  // quantity. null = no limit, 0 (the default) = never past the ordered
  // quantity.
  purchaseOverReceiptPercent: number | null;
  // Automatkontering (B2): standardkonton, always a 4-digit account number —
  // never null/empty on GET (posting-settings.ts's codeSetting falls back to
  // the BAS default when unset). PATCH accepts "" to reset a field back to
  // its default. The revenue and VAT accounts moved to the momskoder
  // (Ekonomi → Momskoder) in migration 0142.
  postingAccountsReceivable: string;
  postingAccountsPayable: string;
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
  // Valuta: kursvinst, kursförlust and bankkostnader — where a payment in
  // another currency books its exchange difference and the bank's fee.
  postingFxGain: string;
  postingFxLoss: string;
  postingBankFees: string;
  // How much a payment may miss the invoice's remaining amount by and still
  // count as fully paid (kr), and the fee charged per payment reminder (kr).
  // Unlike the account codes, there is no reset-to-default — always a number.
  paymentTolerance: number;
  reminderFee: number;
  // Aviseringar: when the daily digest is sent (HH:MM, Stockholm time), how
  // many days ahead "Leverantörsfakturor att betala" looks, and Navs adress
  // for the links in the digest ("" = no links).
  alertDigestTime: string;
  alertSupplierInvoiceDays: number;
  // Offerter att följa upp inom (dagar), 0–60.
  alertQuoteFollowupDays: number;
  // Offertens giltighetstid (dagar), 0–365; 0 = ingen giltighetstid.
  quoteValidityDays: number;
  // Ställkostnadsartikel: the article a customer price's ställpris is charged
  // on as its own order row; null = off.
  setupChargeArticleId: string | null;
  publicBaseUrl: string;
  // Dröjsmålsränta och förseningsersättning (Ekonomi → Konteringsregler):
  // both switches default off; margin in procentenheter over referensräntan
  // (räntelagen 6 §: 8), minsta räntebelopp per räntefaktura in kr, and the
  // two posting accounts (same 4-digit / ""-to-reset convention as above).
  lateInterestEnabled: boolean;
  lateInterestMargin: number;
  lateInterestMinAmount: number;
  lateFeeEnabled: boolean;
  postingLateInterest: string;
  postingLateFee: string;
}

// --- Dröjsmålsränta (Försäljning → Räntefakturering, Ekonomi → Referensränta) ---

// GET /reference-rates row — Riksbankens referensränta for one calendar half
// year (validFrom is always 1 January or 1 July).
export interface ReferenceRateEntry {
  id: string;
  validFrom: string;
  rate: number;
  source: "riksbank" | "manual";
}

// POST /reference-rates/fetch.
export interface ReferenceRateFetchResult {
  fetched: number;
  rows: ReferenceRateEntry[];
}

export interface LateInterestSegment {
  from: string;
  to: string;
  days: number;
  rate: number;
  amount: number;
}

// GET /late-interest/candidates row.
export interface LateInterestCandidate {
  invoiceId: string;
  invoiceNumber: string;
  customerId: string;
  customerName: string;
  privatePerson: boolean;
  dueDate: string;
  paidDate: string | null;
  // Brutto and what is still open on the invoice.
  principal: number;
  openAmount: number;
  // The interest period (day after the due date, or after the last charged
  // period, through the payment date or asOf).
  fromDate: string;
  toDate: string;
  days: number;
  // One rate for the whole period, or null when it spans several (see rates).
  rate: number | null;
  rates: number[];
  // null when a reference rate is missing for the period.
  interest: number | null;
  // Suggested förseningsersättning (450 minus a charged påminnelseavgift).
  fee: number;
  // The interest alone is under Minsta räntebelopp — selectable but not
  // preselected.
  belowMinimum: boolean;
  rateMissing: boolean;
  segments: LateInterestSegment[];
}

export interface LateInterestCandidates {
  asOf: string;
  rows: LateInterestCandidate[];
  // Half-year starts ("YYYY-01-01" / "YYYY-07-01") without a referensränta.
  rateMissing: string[];
}

export interface LateInterestRunItem {
  invoiceId: string;
  fromDate: string;
  includeInterest: boolean;
  includeFee: boolean;
  fee: number;
}

// POST /late-interest/invoices.
export interface LateInterestRunResult {
  created: {
    invoiceId: string;
    invoiceNumber: string | null;
    customerName: string;
    status: string;
    total: number;
  }[];
  skipped: { customerName: string; reason: string }[];
  issueFailed: { invoiceId: string; error: string }[];
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
  // Aviseringar: the daily digest — cannot be resent (the API answers 409).
  | "alert_digest"
  // Kvalitet: an avvikelse's reklamationsrapport.
  | "deviation"
  | "test";
export type EmailStatus = "sent" | "failed";

export const EMAIL_DOCUMENT_TYPE_LABELS: Record<EmailDocumentType, string> = {
  inquiry: "Förfrågan",
  purchase_order: "Inköpsorder",
  quote: "Offert",
  order_confirmation: "Orderbekräftelse",
  invoice: "Faktura",
  payment_reminder: "Betalningspåminnelse",
  alert_digest: "Daglig sammanställning",
  deviation: "Avvikelse",
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
  // Avvikelse mails: whether Orsaksanalys/Åtgärd/Beslut were included (null on other documents).
  includeDetails?: boolean | null;
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
  | "article"
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
  | "stock_count"
  | "quote"
  | "invoice_scan"
  | "deviation";

export const NUMBER_SERIES_LABELS: Record<NumberSeriesKey, string> = {
  article: "Artikelnummer",
  purchase_order: "Inköpsorder",
  quote: "Offert",
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
  invoice_scan: "Fakturainkorg",
  deviation: "Avvikelse",
};

export interface NumberSeries {
  // A built-in key, or a generated one for the user's own article series.
  key: string;
  // Only the user's own article series carry a name.
  name: string | null;
  forArticles: boolean;
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
  earnsAtf: boolean;
  active: boolean;
}

// Avvikelseorsak: reason for a late arrival / early departure (never deleted).
export interface AttendanceDeviationReason {
  id: string;
  code: string;
  name: string;
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
  // Sen ankomst / tidig hemgång in minutes, no tolerance. Optional:
  // snapshots locked before närvaroavvikelser lack them — read as 0.
  lateMinutes?: number;
  earlyLeaveMinutes?: number;
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
  // Avvikelser: days with late/early, and those beyond the tolerance whose
  // stamp lacks a reason. Optional: older locked snapshots lack them.
  deviationDays?: number;
  missingReasonDays?: number;
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
  startReason: { id: string; code: string; name: string } | null;
  startNote: string | null;
  stopReason: { id: string; code: string; name: string } | null;
  stopNote: string | null;
  // The day's sen ankomst / tidig hemgång minutes on the stamp they were
  // measured on (the first/last session overlapping the schedule), else 0.
  lateMinutes?: number;
  earlyLeaveMinutes?: number;
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
  // Endast läsning (never on an administrator).
  readOnly: boolean;
  // "plugin" = a Tillägg's technical user (managed under System → Tillägg).
  kind?: "person" | "plugin";
}

export interface PermissionGroup {
  id: string;
  code: string;
  name: string;
  permissions: Permission[];
  userCount: number;
  // Tillägg: the plugin that owns the group (its technical user's group) —
  // managed under System → Tillägg, never assigned to a person.
  pluginId: string | null;
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
  // Kräver kostnadsställe: a booking on the account without one is refused
  // in manual verifications (409 cost-center-required).
  costCenterRequired: boolean;
  createdAt: string;
}

// --- Kostnadsställen och projekt (bokföringsgranskningen etapp 5 del A) ---
// SIE dimensions 1 (Kostnadsställe) and 6 (Projekt). Registers under
// Ekonomi; mirrors the API contract (GET /cost-centers, GET /projects).
export interface CostCenter {
  id: string;
  code: string;
  name: string;
  active: boolean;
}

export type ProjectStatus = "open" | "closed";

export const PROJECT_STATUS_LABELS: Record<ProjectStatus, string> = {
  open: "Öppet",
  closed: "Stängt",
};

export interface Project {
  id: string;
  code: string;
  name: string;
  active: boolean;
  status: ProjectStatus;
  customerId: string | null;
  customerName: string | null;
  startDate: string | null;
  endDate: string | null;
}

// A cost centre / project as a row, document or report line carries it.
export interface DimensionRef {
  id: string;
  code: string;
  name: string;
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
  costCenter?: DimensionRef | null;
  project?: DimensionRef | null;
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
  // Automatkonteringen's remarks, e.g. a row booked without the cost centre
  // its account requires (Kräver kostnadsställe).
  warnings?: string[];
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

// --- Snabbare manuell bokföring (bokföringsgranskningen etapp 3) ---

// GET /verification-templates — a template carries the series, description
// and the rows; amounts are optional (null = filled in when used).
export interface VerificationTemplateRow {
  id: string;
  accountNumber: string;
  accountName: string | null;
  description: string | null;
  debit: number | null;
  credit: number | null;
  sortOrder: number;
  costCenterId?: string | null;
  projectId?: string | null;
  costCenter?: DimensionRef | null;
  project?: DimensionRef | null;
}

export interface VerificationTemplate {
  id: string;
  name: string;
  seriesId: string;
  seriesCode: string;
  description: string;
  active: boolean;
  rows: VerificationTemplateRow[];
  createdAt: string;
  updatedAt: string;
}

export interface RecurringRun {
  id: string;
  month: string;
  // skipped: the month fell due while the post was paused and was marked
  // on Aktivera — never created.
  status: "created" | "failed" | "skipped";
  error: string | null;
  verificationId: string | null;
  verificationDisplayNumber: string | null;
  createdAt: string;
}

// GET /recurring-verifications — `allocation` is set for the posts that
// Fördela över perioder created (kind "allocation").
export interface RecurringVerification {
  id: string;
  templateId: string;
  templateName: string;
  description: string;
  dayOfMonth: number | "last";
  startMonth: string;
  endMonth: string | null;
  mode: "draft" | "book";
  active: boolean;
  nextRunMonth: string | null;
  nextRunDate: string | null;
  kind: "template" | "allocation";
  allocation: {
    amount: number;
    balanceAccount: string;
    resultAccount: string;
    months: number;
    scheduleAmounts: number[];
  } | null;
  lastRun: RecurringRun | null;
  failedCount: number;
  // A paused post: the months Aktivera would mark skipped right now ([] when active).
  skippedOnActivate: string[];
}

export interface RecurringVerificationDetail extends RecurringVerification {
  runs: RecurringRun[];
}

// PATCH /recurring-verifications/:id — the detail plus the months the
// activation just marked skipped.
export interface RecurringVerificationUpdateResult extends RecurringVerificationDetail {
  skippedMonths: string[];
}

// POST /verifications/:id/copy
export interface VerificationCopyResult {
  verification: VerificationDetail;
  warnings: string[];
}

// POST /sie/verifications/preview
export interface SieVerificationPreviewRow {
  accountNumber: string;
  accountName: string | null;
  // Positive = debit, negative = credit (SIE).
  amount: number;
  description: string | null;
  transDate: string | null;
}

export interface SieVerificationPreviewItem {
  index: number;
  series: string | null;
  number: string | null;
  date: string;
  text: string;
  rows: SieVerificationPreviewRow[];
  debit: number;
  credit: number;
  balanced: boolean;
  warnings: string[];
}

export interface SieVerificationPreview {
  sha256: string;
  fileName: string;
  program: string | null;
  alreadyImported: { importedAt: string; importedBy: string | null } | null;
  verifications: SieVerificationPreviewItem[];
  missingAccounts: { number: string; name: string | null }[];
  // Objects (#OBJEKT) the verifications use that do not exist yet:
  // dimension 1 = Kostnadsställe, 6 = Projekt. Created together with the
  // missing accounts by "Skapa saknade konton och objekt".
  missingObjects?: { dimension: 1 | 6; code: string; name: string | null }[];
  blockers: string[];
  warnings: string[];
}

// POST /sie/verifications/import
export interface SieVerificationImportResult {
  imported: number;
  verifications: { id: string; displayNumber: string | null; date: string; description: string }[];
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
  costCenter?: DimensionRef | null;
  project?: DimensionRef | null;
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
// varugrupp/konto names (economy.repository.ts's listPostingRules), a
// plain array (no pagination). vatCodeId null is the catch-all rule ("Alla
// momskoder" in the UI): the poster applies it to svensk moms, momsfritt and
// goods from outside the EU only. revenue-/costAccountVatBox are the chart's
// momsruta on the rule's accounts.
export interface PostingRule {
  id: string;
  articleGroupId: string;
  vatCodeId: string | null;
  vatCode: string | null;
  vatCodeName: string | null;
  revenueAccountId: string | null;
  costAccountId: string | null;
  createdAt: string;
  groupCode: string;
  groupName: string;
  revenueAccountNumber: string | null;
  revenueAccountName: string | null;
  revenueAccountVatBox: VatBoxSetting | null;
  costAccountNumber: string | null;
  costAccountName: string | null;
  costAccountVatBox: VatBoxSetting | null;
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
  // Kostnadsställe (förval) on the depreciation rows of the group's assets.
  defaultCostCenterId?: string | null;
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

// Swedish label for a posting rule's momskod — null = the catch-all rule.
export function postingVatCodeLabel(rule: Pick<PostingRule, "vatCode" | "vatCodeName">): string {
  if (rule.vatCode === null) return "Alla momskoder";
  return rule.vatCodeName ? `${rule.vatCode} · ${rule.vatCodeName}` : rule.vatCode;
}

// --- Momsrapport (B5, alla rutor i etapp 1 av momskoderna) ---
// GET /vat-report?from=&to= — Skatteverkets deklarationsrutor för en månad, ett
// kvartal eller ett helår, härledda ur bokförda verifikat. boxes är öresbelopp
// (för avstämning mot huvudboken), roundedBoxes samma rutor i hela kronor —
// ruta 49 räknad på de avrundade rutorna, den summa Skatteverket kontrollerar.
export type VatReportBoxes = VatDeclarationBoxes;

// One account the momsomföring empties (a box entering ruta 49 with a
// movement in the period).
export interface VatSettlementPreviewRow {
  accountId: string;
  accountNumber: string;
  accountName: string;
  vatBox: VatBoxSetting | null;
  debit: number;
  credit: number;
  net: number;
}

// Redovisningskontot (ruta 49 in whole kronor) and öres- och kronutjämning
// (what the whole-krona declaration leaves of the öre balances). Positive =
// kredit, negative = debet.
export interface VatSettlementAccount {
  number: string;
  name: string | null;
  amount: number;
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

// Momsruta per konto: accounts the report could not place in a box.
export interface VatUnassignedAccount {
  accountNumber: string;
  accountName: string;
  net: number;
}

// An active momskod whose account carries another box than the code expects
// (or is missing from the chart).
export interface VatCodeBoxMismatch {
  code: VatCode;
  slot: VatCodeSlot;
  accountNumber: string;
  expectedBox: VatBoxSetting;
  actualBox: VatBoxSetting | null;
  problem: "box_mismatch" | "missing_account";
  message: string;
}

// A konteringsregel whose account lands in the wrong momsruta: the account of
// an exact utrikes-/omvänd code without the code's box, of MP25/MP12/MP6/MF or
// "Alla momskoder" outside ruta 05/42, or a cost account for svensk moms with
// an inköpsruta (20–24, 37, 50). A rule can give one row per account
// (slot), so the key is `${ruleId}-${slot}`.
export interface VatRuleBoxMismatch {
  ruleId: string;
  groupCode: string;
  groupName: string;
  // null = the group's rule for "Alla momskoder".
  code: VatCode | null;
  slot: "revenue" | "cost";
  accountNumber: string;
  // The one box the account should carry — null when several would do
  // (expectedBoxes) or the problem is a forbidden inköpsruta.
  expectedBox: VatBoxSetting | null;
  // Every box that would be in order; empty for purchase_box.
  expectedBoxes: VatBoxSetting[];
  actualBox: VatBoxSetting | null;
  problem: "box_mismatch" | "purchase_box";
  message: string;
}

// The redovisningskonto för moms / öres- och kronutjämning carrying a box the
// momsomföring empties — the report still shows, only Bokför momsomföring
// refuses (409 vat-accounts-not-distinct).
export interface VatSettlementAccountProblem {
  // settlement = redovisningskonto för moms, rounding = öres- och kronutjämning.
  role: "settlement" | "rounding";
  accountNumber: string;
  vatBox: VatBoxSetting;
  message: string;
}

export interface VatReportResponse {
  from: string;
  to: string;
  boxes: VatReportBoxes;
  roundedBoxes: VatReportBoxes;
  settlement: {
    rows: VatSettlementPreviewRow[];
    settlementAccount: VatSettlementAccount;
    roundingAccount: VatSettlementAccount;
  };
  settlements: VatReportSettlement[];
  periods: { id: string; startDate: string; endDate: string; status: AccountingPeriodStatus }[];
  warnings: {
    unassignedAccounts: VatUnassignedAccount[];
    vatCodeBoxMismatches: VatCodeBoxMismatch[];
    ruleBoxMismatches: VatRuleBoxMismatch[];
    settlementAccountProblems: VatSettlementAccountProblem[];
  };
}

// GET/PATCH /settings/vat-reporting — Redovisningsperiod för moms and the
// contact for the periodisk sammanställning.
export interface VatReportingSettings {
  period: VatReportingPeriod;
  contactName: string | null;
  contactPhone: string | null;
  contactEmail: string | null;
}

// GET /periodic-summary?from&to — Periodisk sammanställning (EU-försäljning
// per köparens momsnummer). Amounts are whole kronor; credit invoices count
// negatively. `triangular` (trepartshandel) is always null — it has no code.
export type PeriodicSummaryWarningKind =
  | "missing_vat_number"
  | "invalid_vat_number"
  | "ledger_difference"
  | "non_eu_country";

export type PeriodicSummaryMissingField = "vatNumber" | "contactName" | "contactPhone";

export interface PeriodicSummaryInvoiceRef {
  id: string;
  invoiceNumber: string;
}

export interface PeriodicSummaryRow {
  vatNumber: string;
  customers: { id: string; name: string }[];
  goods: number;
  triangular: number | null;
  services: number;
  invoices: PeriodicSummaryInvoiceRef[];
}

export interface PeriodicSummaryWarning {
  kind: PeriodicSummaryWarningKind;
  message: string;
  invoices: PeriodicSummaryInvoiceRef[];
}

export interface PeriodicSummaryResponse {
  from: string;
  to: string;
  kind: "month" | "quarter";
  periodCode: string;
  rows: PeriodicSummaryRow[];
  totals: { goods: number; services: number };
  // Momsrapportens bokföring för samma period: ruta 35 (varor) och ruta 39
  // (tjänster), i hela kronor, och skillnaden mot sammanställningen.
  ledger: { box35: number; box39: number };
  differences: { goods: number; services: number };
  warnings: PeriodicSummaryWarning[];
  reporter: {
    vatNumber: string | null;
    contactName: string | null;
    contactPhone: string | null;
    contactEmail: string | null;
  };
  // What the file still needs (409 periodic-summary-reporter-incomplete).
  missing: PeriodicSummaryMissingField[];
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
  // Only with groupBy: the amount per column of the response, in column order.
  amounts?: number[];
}

// Resultaträkning med budget (?budgetId=): credit-positive like the rest of
// the report; variance = utfall − budget (positive = better than budget).
// variancePercent is null when the budget is 0. Present on every line,
// subtotal and account of a response that has `budget`.
export interface BudgetFigures {
  budget: number;
  variance: number;
  variancePercent: number | null;
  accumulated: number;
  accumulatedBudget: number;
  accumulatedVariance: number;
  accumulatedVariancePercent: number | null;
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

// The income statement's account: accountId is null only with ?budgetId=, for
// a budgeted account the chart no longer has (no ledger link then — the id
// guard would refuse the number).
export type IncomeStatementAccount = Omit<ReportAccount, "accountId"> & { accountId: string | null } & Partial<BudgetFigures>;

export type IncomeStatementEntry =
  | ({ kind: "line"; key: string; label: string; accounts: IncomeStatementAccount[]; total: number; amounts?: number[] } & Partial<BudgetFigures>)
  | ({ kind: "subtotal"; key: string; label: string; total: number; amounts?: number[] } & Partial<BudgetFigures>);

// One column of "Per kostnadsställe"/"Per projekt": an object, or the rows
// without one (id/code null).
export interface IncomeStatementColumn {
  id: string | null;
  code: string | null;
  name: string;
}

export interface IncomeStatementResponse {
  from: string;
  to: string;
  entries: IncomeStatementEntry[];
  result: number;
  // Only with groupBy.
  columns?: IncomeStatementColumn[];
  // Only with ?budgetId=: the budget used, the start of the fiscal year (the
  // accumulated columns run from there) and the result row's figures.
  budget?: { id: string; name: string; fiscalYearId: string };
  accumulatedFrom?: string;
  resultBudget?: number;
  resultVariance?: number;
  resultVariancePercent?: number | null;
  resultAccumulated?: number;
  resultAccumulatedBudget?: number;
  resultAccumulatedVariance?: number;
  resultAccumulatedVariancePercent?: number | null;
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
  safetyStock: number | null;
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

// Leveransprecision, Gruppera Motpart (Kvalitet): per customer/supplier, with
// the quality columns. defectFreePct is a whole percent; deviationCost is null
// without prices; claimedQuantity is null for mixed units (see claimedByArticle).
export interface PrecisionCounterpartyFigures {
  total: number;
  onTime: number;
  late: number;
  precisionPct: number | null;
  avgDaysLate: number | null;
  deviations: number;
  ordersWithDeviation: number;
  defectFreePct: number | null;
  claimedQuantity: number | null;
  claimedUnit: string | null;
  claimedByArticle: {
    articleId: string | null;
    articleNumber: string | null;
    articleName: string | null;
    unitCode: string | null;
    quantity: number;
  }[];
  deviationCost: number | null;
}

export interface PrecisionCounterparty extends PrecisionCounterpartyFigures {
  counterpartyId: string;
  counterpartyName: string;
}

export interface PrecisionSection {
  months: PrecisionMonth[];
  // Only with groupBy=counterparty.
  counterparties?: { rows: PrecisionCounterparty[]; totals: PrecisionCounterpartyFigures };
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
  groupBy?: "month" | "counterparty";
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
  // onlyPost: orders whose latest efterkalkyl has no comparable förkalkyl (none
  // saved on the article at or before it, or a beställningsvara's TO).
  notComparable: { onlyPost: number; invalidQuantity: number };
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
  vat_code: "Momskod",
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
  einvoice_settings: "E-fakturainställningar",
  // Fakturaskanning.
  invoice_scan: "Fakturainkorg",
  invoice_scan_settings: "Fakturaskanningsinställningar",
  theme: "Tema",
  plugin: "Tillägg",
};

export const AUDIT_ACTION_LABELS: Record<string, string> = {
  demo_data_created: "Exempeldata skapad",
  created: "Skapad",
  updated: "Ändrad",
  vat_code_changed: "Momskod ändrad",
  onboarding_number_series_reviewed: "Nummerserier granskade",
  deleted: "Borttagen",
  // Fakturaskanning: a file arrived in the inbox / was turned into a
  // supplier invoice / was rejected / restored.
  received: "Mottagen",
  converted: "Leverantörsfaktura skapad",
  rejected: "Avvisad",
  restored: "Återställd",
  set: "Satt",
  attendance_stopped: "Gick hem",
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
  lost: "Förlorad",
  reopened: "Öppnad igen",
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
  material_added: "Material tillagt",
  material_changed: "Material ändrat",
  material_removed: "Material borttaget",
  operation_added: "Operation tillagd",
  operation_changed: "Operation ändrad",
  operation_removed: "Operation borttagen",
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
  supplier_changed: "Leverantör ändrad",
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
  einvoice_sent: "E-faktura skickad",
  einvoice_failed: "E-faktura misslyckad",
  theme_created: "Tema skapat",
  theme_updated: "Tema ändrat",
  theme_deleted: "Tema borttaget",
  plugin_installed: "Tillägg installerat",
  plugin_updated: "Tillägg ändrat",
  plugin_paused: "Tillägg pausat",
  plugin_activated: "Tillägg aktiverat",
  plugin_key_rotated: "Ny API-nyckel",
  plugin_secret_rotated: "Ny webbhookshemlighet",
  plugin_uninstalled: "Tillägg avinstallerat",
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

export type PalletCardCode = "none" | "barcode" | "qr";

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
    // Valutaomvärdering (valuta steg 4). `required` = open invoices in another
    // currency than SEK per the closing date; false + not_done = "Inga
    // valutaposter" (the step can still be marked done and blocks nothing).
    fxRevaluation: {
      status: "not_done" | "done" | "stale";
      required: boolean;
      verification: YearEndVerificationRef | null;
      reversalVerification: YearEndVerificationRef | null;
      bookedAt: string | null;
      bookedRates: YearEndFxRate[] | null;
      preview: YearEndFxPreview;
    };
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

// Valutaomvärdering: a rate as stored on the booking. `source` "step" = typed
// in the step (no rate day, date null).
export type YearEndFxRateSource = "riksbank" | "manual" | "step";

export interface YearEndFxRate {
  currency: string;
  rate: number;
  date: string | null;
  source: YearEndFxRateSource;
}

// A rate as the step shows it: null while no source has one for the currency,
// fromBooking = the live booking's rate (kept as the default on a re-run).
export interface YearEndFxRateView {
  currency: string;
  rate: number | null;
  date: string | null;
  source: YearEndFxRateSource | null;
  fromBooking: boolean;
}

export interface YearEndFxCurrencySummary {
  currency: string;
  rate: number | null;
  invoiceCount: number;
  openAmount: number;
  bookedSek: number;
  revaluedSek: number | null;
  difference: number | null;
}

// One reskontra side. Differences follow the reskontra's sign: + on a
// receivable is a kursvinst, + on a payable a kursförlust.
export interface YearEndFxSide {
  accountNumber: string;
  invoiceCount: number;
  bookedSek: number;
  revaluedSek: number | null;
  difference: number | null;
  currencies: YearEndFxCurrencySummary[];
}

export interface YearEndFxPreview {
  asOf: string;
  rates: YearEndFxRateView[];
  missingCurrencies: string[];
  receivable: YearEndFxSide;
  payable: YearEndFxSide;
  // Receivable difference − payable difference (+ = net kursvinst); null while
  // a rate is missing.
  resultEffect: number | null;
  rows: YearEndPostingRow[];
  unchanged: boolean;
}

export interface YearEndFxInvoice {
  side: "receivable" | "payable";
  id: string;
  number: string;
  partnerName: string;
  currency: string;
  exchangeRate: number | null;
  openAmount: number;
  bookedSek: number;
  rate: number | null;
  revaluedSek: number | null;
  difference: number | null;
}

// GET /year-end-closings/:id/fx-revaluation-preview
export interface YearEndFxPreviewWithInvoices extends YearEndFxPreview {
  invoices: YearEndFxInvoice[];
}

// POST /year-end-closings/:id/fx-revaluation
export interface YearEndFxBookResult {
  unchanged: boolean;
  verification: YearEndVerificationRef | null;
  reversalVerification: YearEndVerificationRef | null;
  cancelled: YearEndVerificationRef[];
  nextFiscalYearCreated: boolean;
  rates: YearEndFxRate[];
  revaluation: { receivable: Omit<YearEndFxSide, "accountNumber">; payable: Omit<YearEndFxSide, "accountNumber">; resultEffect: number | null };
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
  // Valuta steg 2: what the company needs for a payment abroad — the account
  // kinds the bank takes as debit account for it (always IBAN so far).
  foreignDebitAccountKinds: DebitAccountKind[];
}
export interface BankSettingsView {
  profile: BankProfileId | null;
  initiatingPartyId: string | null;
  debtorAgreementId: string | null;
  debitAccountKind: DebitAccountKind | null;
  profiles: BankProfileView[];
  company: { name: string; orgNumber: string | null; postalCode: string | null; city: string | null; iban: string | null; bic: string | null; bankgiro: string | null; plusgiro: string | null };
  missing: string[];
  // What payments abroad still need (not part of `missing`), null = nothing.
  foreignProblem: string | null;
}

// Bankfiler.
export type SupplierPaymentMethodValue = "bankgiro" | "plusgiro" | "bank_account" | "iban" | "foreign_account";
export type PaymentKindValue = "domestic" | "sepa" | "international";
export interface SupplierPaymentFields {
  paymentMethod: SupplierPaymentMethodValue | null;
  bankgiro: string | null;
  plusgiro: string | null;
  bankClearing: string | null;
  bankAccountNumber: string | null;
  iban: string | null;
  bic: string | null;
  // Utlandsbetalningar (valuta steg 2): an account number without IBAN, the
  // national bank id (clearingSystem USABA/CACPA/… + clearingMemberId), the
  // bank's name, Avgiftsfördelning (SHAR/DEBT) and Skatteverkets betalningskod.
  foreignAccountNumber: string | null;
  clearingSystem: string | null;
  clearingMemberId: string | null;
  bankName: string | null;
  chargeBearer: "SHAR" | "DEBT";
  paymentReportingCode: string;
}
// KU81: the payment is reported to Skatteverket with `code`; rateMissing = no
// exchange rate was found, so it is reported to be safe.
export interface RegulatoryReportingView {
  code: string;
  amountSek: number | null;
  rateMissing: boolean;
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
  // Valuta steg 2 (every export since then): what the file said about the
  // payee abroad. Absent on older snapshots.
  kind?: PaymentKindValue;
  currency?: string;
  street?: string | null;
  country?: string;
  clearingSystem?: string | null;
  bankName?: string | null;
  chargeBearer?: "SLEV" | "SHAR" | "DEBT";
}
export interface CurrencyAmount {
  currency: string;
  amount: number;
}
export interface PaymentBatchListRow {
  id: string;
  batchNumber: string;
  status: "draft" | "exported" | "confirmed" | "cancelled";
  createdAt: string;
  exportedAt: string | null;
  itemCount: number;
  confirmedCount: number;
  // SEK rows only; every currency (SEK included) is in totalsByCurrency.
  totalAmount: number;
  totalsByCurrency: CurrencyAmount[];
  earliestExecutionDate: string | null;
}
export interface PaymentBatchItem {
  id: string;
  seq: number;
  endToEndId: string;
  status: "pending" | "exported" | "confirmed" | "rejected" | "returned" | "cancelled";
  // In `currency` (the invoice's).
  amount: number;
  currency: string;
  // Inrikes/SEPA/Utland — null while the supplier has no payment details.
  paymentKind: PaymentKindValue | null;
  // KU81 marking, null = not reported.
  regulatoryReporting: RegulatoryReportingView | null;
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
  // What the export would refuse for this row (draft only).
  problems: string[];
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
  totalsByCurrency: CurrencyAmount[];
  itemCount: number;
  confirmedCount: number;
  // What the export would refuse for the batch as a whole (draft only), e.g.
  // a missing debit IBAN for payments abroad.
  problems: string[];
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
  // The entry's own amount in the account's currency (SEK).
  amount: number;
  currency: string;
  // Valuta steg 2: what was instructed in another currency (InstdAmt), the
  // bank's exchange details and the charges included in `amount`.
  instructedAmount: number | null;
  instructedCurrency: string | null;
  currencyExchange: { sourceCurrency: string; targetCurrency: string | null; unitCurrency: string | null; rate: string } | null;
  chargesAmount: number | null;
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
    // In the item's currency (the invoice's).
    amount: number;
    currency: string;
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
  // Valuta: the currency the rows settle in (the open items' — the account's
  // or the instructed one); null when nothing is proposed.
  currency: string | null;
  customerId: string | null;
  customerName: string | null;
  rows: IncomingProposalRow[];
  alternatives: { invoiceId: string; invoiceNumber: string; customerId: string; customerName: string; openAmount: number; dueDate: string | null }[];
}
export interface IncomingEntryView {
  id: string;
  position: number;
  // The entry's own amount in the account's currency (SEK).
  amount: number;
  currency: string;
  // Valuta steg 3: a payment instructed in another currency (InstdAmt) is
  // matched against open items in that currency (the proposal's amounts are in
  // it) and booked with `amount` as the SEK value; the bank's exchange details
  // and the charges included in `amount`.
  instructedAmount: number | null;
  instructedCurrency: string | null;
  currencyExchange: { sourceCurrency: string; targetCurrency: string | null; unitCurrency: string | null; rate: string } | null;
  chargesAmount: number | null;
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
  // Produktionsplanering: planned weeks (Mondays); null = unplanned.
  plannedStartWeek: string | null;
  plannedEndWeek: string | null;
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

// Leveranstidskontroll: POST /delivery-time-check. One step in a row's
// limiting chain, in time order.
export type DtcStep =
  | { kind: "stock"; articleNumber: string; quantity: number; date: string }
  | {
      kind: "supply";
      articleNumber: string;
      quantity: number;
      date: string;
      documentType: "sales_order" | "purchase_order" | "manufacturing_order";
      documentNumber: string;
      undated: boolean;
      // The order's own date is before today (`date` is that own date).
      late: boolean;
      // A purchase order draft.
      isDraft: boolean;
    }
  | {
      kind: "purchase";
      articleNumber: string;
      quantity: number;
      date: string;
      supplierName: string | null;
      leadTimeDays: number | null;
    }
  | {
      kind: "operation";
      articleNumber: string;
      quantity: number;
      sequenceNo: number;
      description: string | null;
      workCenterCode: string;
      workCenterName: string;
      // Mondays of the first and last week the operation occupies.
      fromWeek: string;
      toWeek: string;
      // Minutes booked per week (Mondays).
      weeks?: { monday: string; minutes: number }[];
      date: string;
    }
  | {
      kind: "subcontract";
      articleNumber: string;
      quantity: number;
      sequenceNo: number;
      description: string | null;
      workCenterCode: string;
      workCenterName: string;
      leadTimeDays: number | null;
      date: string;
    };

export interface DeliveryTimeCheckRow {
  key: string;
  articleId: string;
  articleNumber: string;
  quantity: number;
  readyDate: string | null;
  chain: DtcStep[];
  notes: string[];
}

// A shortage batch the check would have made — "Använd datumet" can create a
// manufacturing order per batch (POST /delivery-time-check/apply).
export interface DtcBatch {
  key: string;
  rowKey: string;
  // 1 = the order row's own article, 2+ = semi-finished goods below it.
  level: number;
  articleId: string;
  articleNumber: string;
  quantity: number;
  readyDate: string | null;
  operations: { sequenceNo: number; workCenterId: string; weeks: { monday: string; minutes: number }[] }[];
}

// POST /delivery-time-check/apply.
export interface ApplyDeliveryTimeResult {
  deliveryDate: string;
  shipDate: string;
  manufacturingOrders: {
    id: string;
    orderNumber: string;
    articleNumber: string;
    quantity: number;
    level: number;
    salesOrderRowId: string | null;
  }[];
  // Plain texts, or plan warnings carrying a message.
  warnings: (string | { message: string })[];
}

export interface DeliveryTimeCheckResult {
  shipDate: string | null;
  // = shipDate without a customer; null = some row has no date.
  deliveryDate: string | null;
  rows: DeliveryTimeCheckRow[];
  notes: string[];
  // Shortage batches of manufactured articles; empty/absent = nothing to create.
  batches?: DtcBatch[];
}

// --- Egna teman (mirror of packages/shared/src/themes.ts) -------------------

export interface ThemeBootEntry {
  id: string;
  label: string;
  scheme: ThemeScheme;
  builtIn: boolean;
}

// GET /theme-boot — userTheme only with a session (null = company default).
export interface ThemeBoot {
  css: string;
  themes: ThemeBootEntry[];
  defaultTheme: string;
  locked: boolean;
  userTheme?: string | null;
}

// What the root layout hands the client (ThemeBootProvider): the boot
// without its CSS, which is already in <head> — serialised once, not twice.
export type ThemeBootClient = Omit<ThemeBoot, "css">;

export type ThemeOrigin = "builtin" | "uploaded" | "editor";

export interface ThemeListRow {
  id: string;
  key: string;
  name: string;
  scheme: ThemeScheme;
  builtIn: boolean;
  origin: ThemeOrigin;
  needsReview: boolean;
  usedBy: number;
  isDefault: boolean;
  createdAt: string | null;
  updatedAt: string | null;
}

export interface ThemeDetail extends ThemeListRow {
  tokens: Record<string, string>;
  source: ThemeSource | null;
  warnings: ThemeIssue[];
  contrastFailures: ThemeContrastFailure[];
}

export type { ThemeContrastFailure, ThemeIssue, ThemeScheme, ThemeSource, ThemeValidationResult };

// --- Bankavstämning (bokföringsgranskningen etapp 4) -------------------------
// Mirror of the banking module's reconciliation routes. Amounts are numbers,
// signed from the bank account's point of view (+ = in on the account), dates
// "YYYY-MM-DD".

export interface BankCsvMapping {
  delimiter?: ";" | "," | "\t";
  dateColumn: string;
  amountColumn: string;
  textColumn: string;
  balanceColumn?: string;
  valueDateColumn?: string;
  referenceColumn?: string;
  decimalComma?: boolean;
  skipRows?: number;
}

export interface BankAccount {
  id: string;
  name: string;
  identifier: string;
  ledgerAccount: string;
  ledgerAccountName: string | null;
  currency: string;
  active: boolean;
  csvMapping: BankCsvMapping | null;
  reconciledThrough: string | null;
  lastStatementDate: string | null;
  unmatchedCount: number;
  // Entries or matchings exist: Huvudbokskonto and currency are locked.
  hasActivity: boolean;
}

export interface BankRuleSuggestion {
  ruleId: string;
  accountNumber: string;
  description: string | null;
  vatCode: string | null;
  // The rule's Kostnadsställe/Projekt, prefilled on the counter row.
  costCenterId?: string | null;
  projectId?: string | null;
}

// An entry on the statement as the repository reads it (StatementEntryView);
// `details` is the parsed camt.053 detail block, read by nothing on the web.
export interface BankStatementEntryBase {
  id: string;
  bankAccountId: string;
  bankStatementId: string;
  bookingDate: string;
  valueDate: string | null;
  amount: number;
  currency: string;
  text: string;
  reference: string | null;
  counterparty: string | null;
  details: unknown;
  reversal: boolean;
  bankFileId: string;
  createdAt: string;
}

// An unmatched entry in the reconciliation view: the base plus the one bank
// rule that recognises it (null when none or several do).
export interface BankStatementEntry extends BankStatementEntryBase {
  ruleSuggestion: BankRuleSuggestion | null;
}

export interface BankLedgerRow {
  // verification_row_id
  id: string;
  verificationId: string;
  verificationDisplayNumber: string;
  date: string;
  description: string;
  // debet − kredit on the bank account's ledger account
  amount: number;
}

// opening = the Startpunkt: links everything up to the opening day without
// the sum rule; undoing it withdraws its reconciliation mark too.
export type BankMatchKind = "auto" | "manual" | "created" | "opening";

// A matching. The view lists live ones only (the Startpunkt always, whatever
// the period); POST /bank-matches/:id/undo answers the match stamped
// `undoneAt`. The entries carry no ruleSuggestion.
export interface BankMatch {
  id: string;
  kind: BankMatchKind;
  createdAt: string;
  createdBy: string | null;
  undoneAt: string | null;
  entries: BankStatementEntryBase[];
  rows: BankLedgerRow[];
}

// reversal = a statement entry flagged as a reversal netted against its
// original entry (no rows).
export interface BankMatchProposal {
  entryIds: string[];
  rowIds: string[];
  basis: "reference" | "reversal" | "amount_date";
  ambiguous: boolean;
}

export interface BankReconciliationRecord {
  id: string;
  throughDate: string;
  statementBalance: number;
  ledgerBalance: number;
  // The Startpunkt's mark, written by the opening matching `matchId`.
  opening: boolean;
  matchId: string | null;
  createdAt: string;
  createdBy: string | null;
}

// saldo bank − saldo bok = Σ omatchade poster − Σ omatchade rader + I transit,
// all per statementBalanceDate. inTransit is what the matchings crossing the
// day contribute; expectedDifference is the right-hand side.
export interface BankReconciliationSummary {
  statementBalance: number | null;
  statementBalanceDate: string | null;
  ledgerBalance: number;
  unmatchedEntriesSum: number;
  unmatchedRowsSum: number;
  inTransit: number;
  difference: number | null;
  expectedDifference: number;
  explained: boolean;
}

// POST /bank-accounts/:id/opening — the Startpunkt: its mark and matching.
export interface BankOpeningResult {
  reconciliation: BankReconciliationRecord;
  match: BankMatch;
}

export interface BankReconciliationView {
  bankAccount: BankAccount;
  from: string;
  to: string;
  statementEntries: BankStatementEntry[];
  ledgerRows: BankLedgerRow[];
  matches: BankMatch[];
  summary: BankReconciliationSummary;
  reconciliations: BankReconciliationRecord[];
  // Rows on the ledger account dated ≤ the latest mark that were booked after
  // it or are unmatched now, and unmatched entries ≤ the mark.
  changedAfterReconciliation: { through: string; rows: number; entries: number } | null;
  proposals: BankMatchProposal[];
}

export interface BankStatementPreviewEntry {
  bookingDate: string;
  valueDate: string | null;
  amount: number;
  text: string;
  reference: string | null;
  counterparty: string | null;
  duplicate: boolean;
  ruleId: string | null;
}

export interface BankStatementPreviewStatement {
  accountIdentifier: string | null;
  bankAccountId: string | null;
  from: string | null;
  to: string | null;
  openingBalance: number | null;
  closingBalance: number | null;
  entryCount: number;
  newEntryCount: number;
  duplicateCount: number;
  entries: BankStatementPreviewEntry[];
}

export interface BankStatementPreview {
  sha256: string;
  format: "camt.053" | "csv";
  statements: BankStatementPreviewStatement[];
  csvHeaders: string[] | null;
  needsMapping: boolean;
  unknownAccounts: string[];
  warnings: string[];
  blockers: string[];
}

export interface BankStatementImportResult {
  bankFileId: string;
  statements: { id: string; bankAccountId: string; from: string | null; to: string | null }[];
  imported: number;
  duplicates: number;
  autoMatched: number;
  autoBooked: number;
  warnings: string[];
}

export type BankRuleDirection = "in" | "out" | "both";

export interface BankRule {
  id: string;
  textContains: string;
  direction: BankRuleDirection;
  accountNumber: string;
  accountName: string | null;
  vatCode: string | null;
  description: string | null;
  autoBook: boolean;
  active: boolean;
  sortOrder: number;
  costCenterId?: string | null;
  projectId?: string | null;
  costCenter?: DimensionRef | null;
  project?: DimensionRef | null;
}

// POST /bank-statement-entries/book-by-rule: one verification per entry, each
// in its own transaction; a failed entry carries the API's error body (the
// same `{ error, code }` envelope a 4xx answer has) so the web can translate it.
export interface BankBookByRuleResult {
  booked: { entryId: string; verificationId: string; displayNumber: string }[];
  failed: { entryId: string; error: { error: string; code?: string } }[];
}

// --- Budget (bokföringsgranskningen etapp 5 del B) ---
// Mirrors the API contract (GET /budgets, GET /budgets/:id, PUT
// /budgets/:id/lines, POST /budgets/:id/copy, GET /budgets/:id/actuals).
// Amounts are in the account's NATURAL sign: revenue and cost both positive.
export interface BudgetSummary {
  id: string;
  fiscalYearId: string;
  fiscalYearLabel: string;
  name: string;
  isDefault: boolean;
  revenue: number;
  costs: number;
  result: number;
  updatedAt: string;
}

export interface BudgetMonth {
  // 1..N, the period's ordinal in the fiscal year.
  month: number;
  startDate: string;
  endDate: string;
  // "YYYY-MM" of the period's start date.
  label: string;
}

// One (account, cost centre) pair with an amount per month (length N, 0 where
// the row has none). costCenterId null = Ej fördelat.
export interface BudgetGridLine {
  accountNumber: string;
  accountName: string | null;
  costCenterId: string | null;
  amounts: number[];
}

export interface BudgetDetail {
  id: string;
  fiscalYearId: string;
  fiscalYearLabel: string;
  fiscalYearStart: string;
  fiscalYearEnd: string;
  name: string;
  isDefault: boolean;
  months: BudgetMonth[];
  lines: BudgetGridLine[];
}

// POST /budgets/:id/copy
export interface BudgetCopyResult extends BudgetDetail {
  droppedMonths: number;
}

// GET /budgets/:id/actuals — nothing is saved.
export interface BudgetActualsResponse {
  lines: BudgetGridLine[];
}

// POST /budgets/:id/csv/parse — nothing is saved.
export interface BudgetCsvParseResult {
  lines: BudgetGridLine[];
  errors: { row: number; message: string }[];
}

// Lagringsutrymme (GET /storage, admin): the database size and the stored
// files per kind — all uploaded files live in the database.
export interface StorageUsage {
  databaseBytes: number;
  filesBytes: number;
  kinds: { key: string; label: string; count: number; bytes: number }[];
}

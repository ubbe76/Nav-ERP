import {
  normalizeSupplierPaymentDetails,
  DEFAULT_PAYMENT_REPORTING_CODE,
  type SupplierPaymentContext,
  roundUpToMultiple,
  supplierPaymentDetailsProblems,
  toBasePrice,
  toBaseQuantity,
  toUnitPrice,
  toUnitQuantity,
  type SupplierPaymentDetails,
} from "@navet/shared";
import type {
  CreateArticleSupplierInput,
  CreateContactInput,
  CreateDeliveryAddressInput,
  CreateInquiryInput,
  CreateInquiryRowInput,
  CreatePurchaseOrderInput,
  CreatePurchaseOrderRowInput,
  CreateSupplierInput,
  ListGoodsReceiptsQuery,
  ListInquiriesQuery,
  ListPriceHistoryQuery,
  ListPurchaseInvoiceBasisQuery,
  ListPurchaseOrdersQuery,
  PalletCardCode,
  ListQuery,
  PurchaseOrderStatus,
  ReceiveGoodsInput,
  SendDocumentEmailInput,
  UpdateArticleSupplierInput,
  UpdateContactInput,
  UpdateDeliveryAddressInput,
  UpdateInquiryHeaderInput,
  UpdateInquiryRowInput,
  UpdatePurchaseOrderHeaderInput,
  UpdatePurchaseOrderRowInput,
  UpdateSupplierInput,
} from "@navet/shared";
import type { Tx } from "@navet/db";
import { InvalidStatusTransitionError as MoInvalidStatusTransitionError } from "../../manufacturing/service/manufacturing.service.js";
import type { LegoSnapshot, PurchaseRepository } from "../repository/purchase.repository.js";
import type { RegisterReferenceReader } from "../../register/service/register.service.js";
import { RegisterEntryNotFoundError } from "../../register/service/register.service.js";
import type { MailService } from "../../mail/service/mail.service.js";
import type { DocumentPdfService } from "../../mail/service/document-pdf.js";
import { mergePdfs } from "../../mail/service/pdf-merge.js";
import type { ArticleFileReader, ArticleRevisionReader, ArticleUnitReader } from "../../article/service/article.service.js";
import { ArticleNotFoundError, assertPurchasableArticle } from "../../article/service/article.service.js";
import { formatArticleAttributes, formatRevisionInfo, type DocumentSettingsReader } from "../../mail/service/document-pdf.js";
import { isForeignKeyViolation, isUniqueViolation } from "../../system/service/db-errors.js";
import type {
  SupplierDeliveryDateQuery,
  SupplierDeliveryDateSuggestion,
  SupplierPriceQuote,
  SupplierPriceQuoteQuery,
} from "@navet/shared";
import {
  deliveryDateWarning,
  deliveryHolidayWindow,
  deliverySummary,
  effectiveDeliverySettings,
  stockholmToday,
  suggestPurchaseDeliveryDate,
} from "../../system/service/delivery-days.js";
import { resolveSupplierPrice } from "./supplier-price.js";
import { documentVatCode, supplierVatCode, vatCodeRef, type VatCodeBook } from "../../economy/service/document-vat-code.js";
// G1: append-only audit trail — optional with a no-op default (see
// sales.service.ts's identical comment) so the many pre-existing test call
// sites keep compiling; app.ts wires the real one.
import type { AuditWriter } from "../../system/repository/audit.repository.js";

// Lego (subcontract): receiving an IO row that buys an MO operation
// auto-reports that operation. Consumer-side interface satisfied
// structurally by the manufacturing service (the StockBalanceReader/
// ArticleFileReader cross-module pattern; wired in app.ts).
export interface SubcontractOperationReporter {
  reportOperationQuantities(
    operationId: string,
    input: {
      quantityOk: number;
      quantityScrapped: number;
      markDone: boolean;
      // Lets the receipt call the operation "done" only once the accumulated
      // quantity_completed covers the MO's order quantity, rather than
      // trusting the IO row's own fully-received flag — see the call site.
      markDoneWhenCovered?: boolean;
      createdBy: string | null;
      // Report log: the TO card lists the report as an IO receipt, which is
      // undone on the IO rather than on the card.
      source?: "purchase_receipt";
      purchaseOrderId?: string;
      // Materialbrist: the receipt's "Rapportera ändå" flag, passed on.
      allowMaterialShortage?: boolean;
    }
  ): Promise<{ reportId: string }>;
  // Materialbrist: asked BEFORE the goods are booked. Throws the
  // manufacturing module's MaterialShortageError when the report the
  // receipt would make draws more material than is in stock and the mode
  // wants the question first; which modes that is, is the manufacturing
  // module's business — the purchase module only passes the flag through.
  assertMaterialBeforeSubcontractReceipt(operationId: string, quantity: number, allow: boolean | undefined): Promise<void>;
  // Ångra inleverans of a lego row: undoes the TO report the receipt made,
  // inside the purchase undo's transaction. Throws the manufacturing domain
  // errors (which roll the IO undo back); returns the audit write to run
  // once the transaction has committed.
  undoPurchaseReceiptReportInTx(tx: Tx, reportId: string, userId: string): Promise<() => Promise<void>>;
}

// What happened to the linked operation when a lego row was received — the
// receipt itself always stands; a failed report (e.g. the TO is already
// done/closed) is returned as a warning, never an error.
export interface OperationReportOutcome {
  ok: boolean;
  message?: string;
}

export class SupplierNotFoundError extends Error {
  constructor(id: string) {
    super(`Supplier ${id} not found`);
    this.name = "SupplierNotFoundError";
  }
}

export class DuplicateSupplierNumberError extends Error {
  constructor(supplierNumber: string) {
    super(`A supplier with number "${supplierNumber}" already exists`);
    this.name = "DuplicateSupplierNumberError";
  }
}

export class ContactNotFoundError extends Error {
  constructor(id: string) {
    super(`Contact ${id} not found`);
    this.name = "ContactNotFoundError";
  }
}

export class DeliveryAddressNotFoundError extends Error {
  constructor(id: string) {
    super(`Delivery address ${id} not found`);
    this.name = "DeliveryAddressNotFoundError";
  }
}

export class PurchaseOrderNotFoundError extends Error {
  constructor(id: string) {
    super(`Purchase order ${id} not found`);
    this.name = "PurchaseOrderNotFoundError";
  }
}

export class PurchaseOrderRowNotFoundError extends Error {
  constructor(id: string) {
    super(`Purchase order row ${id} not found`);
    this.name = "PurchaseOrderRowNotFoundError";
  }
}

export class InvalidStatusTransitionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InvalidStatusTransitionError";
  }
}

export class InquiryNotFoundError extends Error {
  constructor(id: string) {
    super(`Inquiry ${id} not found`);
    this.name = "InquiryNotFoundError";
  }
}

export class InquiryRowNotFoundError extends Error {
  constructor(id: string) {
    super(`Inquiry row ${id} not found`);
    this.name = "InquiryRowNotFoundError";
  }
}

// Lego inquiry rows (→ 404 / 400 / 409 in the routes).
export class LegoOperationNotFoundError extends Error {
  constructor(id: string) {
    super(`Lego operation ${id} not found`);
    this.name = "LegoOperationNotFoundError";
  }
}

export class LegoOperationArticleMismatchError extends Error {
  constructor() {
    super("Legooperationen tillhör en annan artikel");
    this.name = "LegoOperationArticleMismatchError";
  }
}

export class NotLegoOperationError extends Error {
  constructor() {
    super("Operationen ligger inte på en legoresurs");
    this.name = "NotLegoOperationError";
  }
}

// The linked TO operation is done, or its MO is no longer released/in
// progress — a lego link into a closed operation would never be picked up
// by a goods receipt.
export class LegoOperationClosedError extends Error {
  constructor() {
    super("Lego operation is not open");
    this.name = "LegoOperationClosedError";
  }
}

// inquiry_rows has unique(inquiry_id, article_id) — caught on the insert
// rather than pre-checked, same isUniqueViolation pattern as
// DuplicateSupplierNumberError/DuplicateArticleSupplierError above.
export class DuplicateInquiryRowError extends Error {
  constructor() {
    super("Article already on the inquiry — put the operation on a separate inquiry");
    this.name = "DuplicateInquiryRowError";
  }
}

// "Uppdatera beredningens legopris" refused: not a lego row, no answered
// price yet, wrong status, or the routing operation is gone/no longer lego.
export class InquiryRowPriceNotApplicableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InquiryRowPriceNotApplicableError";
  }
}

// Thrown both by a receipt past the row's limit and by a row edit that would
// put the ordered quantity below what has already been received. A receipt
// carries the limit it broke: allowedPercent is the system setting Tillåten
// överleverans (0 = up to the ordered quantity), maxQuantity the row's total
// receivable quantity in the article's base unit. The route puts both on the
// error body so the web can name the percentage.
export class OverReceiptError extends Error {
  constructor(readonly limit?: { allowedPercent: number; maxQuantity: number }) {
    super(
      limit && limit.allowedPercent > 0
        ? `Received quantity would exceed the ordered quantity plus the allowed ${limit.allowedPercent} % over-delivery for this row`
        : "Received quantity would exceed the ordered quantity for this row"
    );
    this.name = "OverReceiptError";
  }
}

export class PurchaseReceiptNotFoundError extends Error {
  constructor(id: string) {
    super(`Purchase receipt ${id} not found`);
    this.name = "PurchaseReceiptNotFoundError";
  }
}

export class PurchaseReceiptAlreadyUndoneError extends Error {
  constructor() {
    super("The receipt has already been undone");
    this.name = "PurchaseReceiptAlreadyUndoneError";
  }
}

// Ångra inleverans takes the goods back out of the location they were
// received to — refused when they are no longer there (used, moved or sold).
// Quantities in the article's base unit; the route puts them on the body.
export class PurchaseReceiptStockMissingError extends Error {
  constructor(
    readonly available: number,
    readonly required: number
  ) {
    super(
      `Inleveransen lade ${required.toLocaleString("sv-SE")} i lager men bara ${available.toLocaleString("sv-SE")} finns kvar på lagerplatsen`
    );
    this.name = "PurchaseReceiptStockMissingError";
  }
}

// A lego receipt's TO report can only be undone while the TO is open or
// done — a closed (or otherwise finished) TO keeps the receipt standing.
export class PurchaseReceiptManufacturingOrderLockedError extends Error {
  constructor() {
    super("The lego receipt's manufacturing order is no longer open, so the receipt cannot be undone");
    this.name = "PurchaseReceiptManufacturingOrderLockedError";
  }
}

export class RowHasReceiptsError extends Error {
  constructor() {
    super("Cannot delete a row that has received goods");
    this.name = "RowHasReceiptsError";
  }
}

// Lego row creation with an unknown MO operation — caught via the
// hand-declared FK (atomic, no cross-module reader; the E3 constraint-catch
// pattern).
export class MoOperationNotFoundError extends Error {
  constructor(id: string) {
    super(`Manufacturing order operation ${id} not found`);
    this.name = "MoOperationNotFoundError";
  }
}

// --- Article supplier catalog errors ---

export class SupplierInactiveError extends Error {
  constructor(id: string) {
    super(`Supplier ${id} is inactive`);
    this.name = "SupplierInactiveError";
  }
}

export class DuplicateArticleSupplierError extends Error {
  constructor() {
    super("This supplier is already on the article's supplier list");
    this.name = "DuplicateArticleSupplierError";
  }
}

export class ArticleSupplierNotFoundError extends Error {
  constructor(id: string) {
    super(`Article supplier row ${id} not found`);
    this.name = "ArticleSupplierNotFoundError";
  }
}

// Bankfiler: the supplier's payment details don't add up (bad check digit,
// or the chosen method's own field missing). The message is Swedish and
// field-specific; the route answers 400 and the web shows it as is.
export class InvalidSupplierPaymentDetailsError extends Error {
  constructor(public problems: Record<string, string>) {
    super(Object.values(problems).join("; "));
    this.name = "InvalidSupplierPaymentDetailsError";
  }
}

const SUPPLIER_PAYMENT_DETAIL_KEYS = [
  "paymentMethod",
  "bankgiro",
  "plusgiro",
  "bankClearing",
  "bankAccountNumber",
  "iban",
  "bic",
  "foreignAccountNumber",
  "clearingSystem",
  "clearingMemberId",
  "bankName",
  "chargeBearer",
  "paymentReportingCode",
] as const;
// A payee abroad needs street, town and country (valuta steg 2), so a PATCH
// of those is checked against the payment details too.
const SUPPLIER_PAYMENT_CONTEXT_KEYS = ["country", "address", "city"] as const;

function paymentDetailsOf(row: Partial<SupplierPaymentDetails>): SupplierPaymentDetails {
  return {
    paymentMethod: row.paymentMethod ?? null,
    bankgiro: row.bankgiro ?? null,
    plusgiro: row.plusgiro ?? null,
    bankClearing: row.bankClearing ?? null,
    bankAccountNumber: row.bankAccountNumber ?? null,
    iban: row.iban ?? null,
    bic: row.bic ?? null,
    foreignAccountNumber: row.foreignAccountNumber ?? null,
    clearingSystem: row.clearingSystem ?? null,
    clearingMemberId: row.clearingMemberId ?? null,
    bankName: row.bankName ?? null,
    chargeBearer: row.chargeBearer ?? "SHAR",
    paymentReportingCode: row.paymentReportingCode ?? DEFAULT_PAYMENT_REPORTING_CODE,
  };
}

function paymentContextOf(row: { country?: string | null; address?: string | null; city?: string | null }): SupplierPaymentContext {
  return { country: row.country ?? "SE", address: row.address ?? null, city: row.city ?? null };
}

function stripUndefined<T extends object>(value: T): Partial<T> {
  return Object.fromEntries(Object.entries(value).filter(([, v]) => v !== undefined)) as Partial<T>;
}

// "TERM01 · Fritt vårt lager"-strings for the PDF's terms lines.
function termLabel(code: string | null, name: string | null) {
  if (!code && !name) return null;
  return [code, name].filter(Boolean).join(" \u00b7 ");
}

// Mail attachments with the same filename collide in most mail clients \u2014
// later duplicates get " (2)", " (3)" \u2026 before the extension. Duplicates
// happen when a lego operation's uploaded file shares its name with an
// article drawing (article-drawing sets are already deduped by articleId).
function dedupeAttachmentFilenames<T extends { filename: string }>(attachments: T[]): T[] {
  const seen = new Map<string, number>();
  return attachments.map((attachment) => {
    const count = seen.get(attachment.filename) ?? 0;
    seen.set(attachment.filename, count + 1);
    if (count === 0) return attachment;
    const dot = attachment.filename.lastIndexOf(".");
    const renamed =
      dot > 0
        ? `${attachment.filename.slice(0, dot)} (${count + 1})${attachment.filename.slice(dot)}`
        : `${attachment.filename} (${count + 1})`;
    return { ...attachment, filename: renamed };
  });
}

// Prisåterföring: writes an answered lego price back to the article's
// routing operation THROUGH the manufacturing service so its lego guards
// (resource must still be subcontract) apply. Implemented by
// ManufacturingService.updateRoutingOperation.
export interface RoutingPriceWriter {
  updateRoutingOperation(
    articleId: string,
    operationId: string,
    input: { unitPrice: number; setupPrice: number | null; subcontractSupplierId: string }
  ): Promise<unknown>;
}

// "Lego för TO-1024 · Op 20 · Ytbehandling" under a lego row on IO/RFQ, or
// "Lego · Op 20 · Ytbehandling" for a TO-less price inquiry.
function legoReference(orderNumber: string | null, sequenceNo: number, description: string | null) {
  const operation = description ? `Op ${sequenceNo} · ${description}` : `Op ${sequenceNo}`;
  return orderNumber ? `Lego för ${orderNumber} · ${operation}` : `Lego · ${operation}`;
}

// The system settings the purchase module reads: the document toggles, the
// over-delivery limit for goods receipts (null = no limit) and the company's
// own customer number at a carrier — printed on the PO/RFQ when the company
// pays the freight.
export interface PurchaseSettingsReader extends DocumentSettingsReader {
  getSettings(): Promise<{
    showRevisionsOnDocuments: boolean;
    showOrderRevisionOnDocuments: boolean;
    purchaseOverReceiptPercent: number | null;
    // Inherited from DocumentSettingsReader (the pallet card is sales/
    // manufacturing's, never printed from here).
    palletCardCode: PalletCardCode;
  }>;
  getCompanyCarrierNumber(carrierId: string): Promise<string | null>;
}

export function createPurchaseService(
  repo: PurchaseRepository,
  registers: RegisterReferenceReader,
  mail: MailService,
  pdf: DocumentPdfService,
  articleFiles: ArticleFileReader &
    ArticleUnitReader &
    ArticleRevisionReader & {
      // Existence check for the article supplier catalog (→ 404).
      // G1: articleNumber is also used to resolve a human-readable label for
      // order-row audit detail (row_added/row_updated/row_deleted).
      // rounding (Avrundning): the step row quantities are rounded up to —
      // see roundForArticle below.
      // configuratorMode: a template in mode variants is refused on new rows
      // (assertOrderableArticle in resolveRowInput).
      getArticle(
        id: string
      ): Promise<{ id: string; articleNumber: string; rounding: string | null; configuratorMode: "variants" | "to_order" | null } | null>;
    },
  settings: PurchaseSettingsReader,
  manufacturing: SubcontractOperationReporter & RoutingPriceWriter,
  // G1: optional, defaults to a no-op — see the import comment above.
  audit: AuditWriter = { log: async () => {} }
) {
  // Per-row revision line for document printing — null when the system
  // setting "show_revisions_on_documents" is off.
  async function revisionInfoMap(articleIds: string[]) {
    const { showRevisionsOnDocuments } = await settings.getSettings();
    if (!showRevisionsOnDocuments) return null;
    return articleFiles.activeRevisionInfo([...new Set(articleIds)]);
  }
  // Order rows may be entered in one of the article's alternative units —
  // resolve the factor snapshot and store quantity/price in the base unit.
  // articles.rounding (Avrundning): the BASE quantity is rounded up to the
  // article's step here in the service (IO rows, RFQ rows and the rows
  // behovsberäkningen's Skapa ordrar adds) — the same roundUpToMultiple the
  // requirements calc applies, so a proposal and its IO agree. A row entered
  // in an alternative unit displays a converted, non-round number afterwards;
  // the step is defined in the base unit by design.
  async function roundForArticle(articleId: string, baseQuantity: number) {
    const article = await articleFiles.getArticle(articleId);
    return roundUpToMultiple(baseQuantity, article?.rounding);
  }
  async function resolveRowInput<T extends { articleId: string; quantity: number; unitPrice?: number | null; unitId?: string | null }>(
    input: T
  ) {
    // Produktkonfigurator: a template in mode variants never goes on a new
    // row (IO addRow, createInquiry, addInquiryRow) — an unknown article is
    // left to the FK as before. One read serves the guard and the rounding.
    const article = await articleFiles.getArticle(input.articleId);
    if (article) assertPurchasableArticle(article);
    const selection = await articleFiles.resolveUnitSelection(input.articleId, input.unitId);
    return {
      ...input,
      quantity: roundUpToMultiple(toBaseQuantity(input.quantity, selection.unitFactor), article?.rounding),
      unitPrice:
        input.unitPrice !== undefined && input.unitPrice !== null
          ? toBasePrice(input.unitPrice, selection.unitFactor)
          : input.unitPrice,
      unitId: selection.unitId,
      unitFactor: selection.unitFactor,
    };
  }
  // Drawings for every distinct article on the order, as extra attachments.
  async function drawingAttachments(articleIds: string[]) {
    const files = await articleFiles.filesWithData([...new Set(articleIds)]);
    return files.map((f) => ({ filename: f.filename, content: f.data }));
  }
  // Extra attachments for a document email. Lego rows' drawings are ALWAYS
  // attached (the subcontractor cannot work without them): the article's
  // own drawings when the operation says "use article drawings" (default
  // when the routing row is gone), otherwise the file uploaded on the
  // operation. The attachDrawings checkbox governs the other rows only. One
  // combined article-id set, so a file never attaches twice.
  async function legoAwareAttachments(
    legoSources: Awaited<ReturnType<PurchaseRepository["subcontractDrawingSources"]>>,
    allArticleIds: string[],
    attachDrawings: boolean
  ) {
    const articleIdsForDrawings = new Set(
      legoSources.filter((s) => s.useArticleDrawing !== false).map((s) => s.articleId)
    );
    if (attachDrawings) for (const articleId of allArticleIds) articleIdsForDrawings.add(articleId);
    const drawings = await drawingAttachments([...articleIdsForDrawings]);
    const operationFiles = legoSources
      .filter((s) => s.useArticleDrawing === false && s.fileData !== null)
      .map((s) => ({ filename: s.fileFilename!, content: s.fileData! }));
    return [...drawings, ...operationFiles];
  }
  // Lego link on an inquiry row: validates the operation (exists, belongs
  // to the row's article, sits on a legoresurs), derives the routing
  // operation for TO rows and defaults the ställpris from the operation.
  // The unit price is never defaulted — an inquiry asks for it.
  async function resolveLegoRow(input: {
    articleId: string;
    moOperationId?: string;
    routingOperationId?: string;
    setupPrice?: number;
  }): Promise<LegoSnapshot> {
    if (!input.moOperationId && !input.routingOperationId) {
      return { moOperationId: null, routingOperationId: null, setupPrice: null };
    }
    const ref = await repo.resolveLegoOperationRef(input);
    if (!ref) throw new LegoOperationNotFoundError(input.moOperationId ?? input.routingOperationId!);
    if (ref.articleId !== input.articleId) throw new LegoOperationArticleMismatchError();
    if (ref.workCenterType !== "subcontract") throw new NotLegoOperationError();
    // A TO operation link (not the TO-less routing-operation link) must
    // still be open — a done operation, or an MO that never got released or
    // was already finished, would never be picked up by a goods receipt.
    if (
      input.moOperationId &&
      (ref.moOperationStatus !== "pending" ||
        (ref.manufacturingOrderStatus !== "released" && ref.manufacturingOrderStatus !== "in_progress"))
    ) {
      throw new LegoOperationClosedError();
    }
    return {
      moOperationId: ref.moOperationId,
      routingOperationId: ref.routingOperationId,
      setupPrice: input.setupPrice ?? (ref.setupPrice !== null ? Number(ref.setupPrice) : null),
    };
  }
  // Assembles the printable PDF for an inquiry — shared by the download
  // endpoint and the email flow.
  async function renderInquiryPdf(inquiry: NonNullable<Awaited<ReturnType<PurchaseRepository["findInquiryById"]>>>) {
    const [supplier, rows] = await Promise.all([
      repo.findSupplierById(inquiry.supplierId),
      repo.listInquiryRows(inquiry.id),
    ]);
    const revisions = await revisionInfoMap(rows.map((r) => r.articleId));
    // Our own carrier customer number, printed only when we pay the freight.
    const carrierCustomerNumber =
      inquiry.freightPaidByUs && inquiry.carrierId
        ? await settings.getCompanyCarrierNumber(inquiry.carrierId)
        : null;
    const content = await pdf.render({
      title: "Förfrågan",
      documentNumber: inquiry.inquiryNumber,
      date: inquiry.createdAt,
      partnerLabel: "Leverantör",
      partner: supplier!,
      currency: supplier!.currency,
      // Printed in the row's unit (the values are stored in the base unit).
      rows: rows.map((r) => {
        const isLego = r.moOperationId !== null || r.routingOperationId !== null;
        return {
          articleNumber: r.articleNumber,
          articleName: r.articleName,
          quantity: String(toUnitQuantity(Number(r.quantity), r.unitFactor)),
          unit: r.unitCode,
          unitPrice: r.unitPrice === null ? null : String(toUnitPrice(Number(r.unitPrice), r.unitFactor)),
          revisionInfo: formatRevisionInfo(revisions?.get(r.articleId)),
          // Lego rows print like the IO's: Ytbehandling/Färg, the operation
          // reference (with the TO when there is one), the ställpris and —
          // when the operation asks for it — the net weight. A lego row
          // whose operation was deleted keeps its ställpris but no heading.
          articleInfo: isLego
            ? formatArticleAttributes({ surfaceTreatment: r.articleSurfaceTreatment, colour: r.articleColour })
            : null,
          moReference:
            isLego && r.legoSequenceNo !== null
              ? legoReference(r.moOrderNumber, r.legoSequenceNo, r.legoDescription)
              : null,
          setupPrice: r.setupPrice,
          netWeightKg:
            isLego && r.legoShowNetWeight && r.articleWeight !== null
              ? Number(r.articleWeight) * Number(r.quantity)
              : null,
        };
      }),
      // An inquiry asks for prices — no total line.
      showTotal: false,
      requestedDeliveryDate: inquiry.expectedDeliveryDate,
      deliveryTerm: termLabel(inquiry.deliveryTermCode, inquiry.deliveryTermName),
      paymentTerm: termLabel(inquiry.paymentTermCode, inquiry.paymentTermName),
      carrier: termLabel(inquiry.carrierCode, inquiry.carrierName),
      carrierCustomerNumber,
      // Live value — no snapshot, same rule as the supplier address block.
      ourCustomerNumberAtSupplier: supplier!.ourCustomerNumber,
    });
    return { filename: `${inquiry.inquiryNumber}.pdf`, content };
  }

  async function renderPurchaseOrderPdf(
    order: NonNullable<Awaited<ReturnType<PurchaseRepository["findPurchaseOrderById"]>>>
  ) {
    const [supplier, rows, { showOrderRevisionOnDocuments }] = await Promise.all([
      repo.findSupplierById(order.supplierId),
      repo.listRowsByOrder(order.id),
      settings.getSettings(),
    ]);
    const revisions = await revisionInfoMap(rows.map((r) => r.articleId));
    // Our own carrier customer number, printed only when we pay the freight.
    const carrierCustomerNumber =
      order.freightPaidByUs && order.carrierId ? await settings.getCompanyCarrierNumber(order.carrierId) : null;
    const content = await pdf.render({
      title: "Inköpsorder",
      documentNumber: order.orderNumber,
      date: order.createdAt,
      partnerLabel: "Leverantör",
      partner: supplier!,
      currency: order.currency,
      // Printed in the row's unit (the values are stored in the base unit).
      rows: rows.map((r) => {
        const isLego = r.moOperationId !== null && r.moOrderNumber !== null && r.moOperationSequenceNo !== null;
        return {
          articleNumber: r.articleNumber,
          articleName: r.articleName,
          quantity: String(toUnitQuantity(Number(r.quantityOrdered), r.unitFactor)),
          unit: r.unitCode,
          unitPrice: String(toUnitPrice(Number(r.unitPrice), r.unitFactor)),
          revisionInfo: formatRevisionInfo(revisions?.get(r.articleId)),
          // Lego: Ytbehandling/Färg from the article, the TO reference under
          // the row, the one-off ställpris (its own sub-line, added once to
          // the row amount) and — when the operation asks for it — the net
          // weight (article weight × base quantity; no line at all when the
          // article has no weight).
          articleInfo: isLego
            ? formatArticleAttributes({ surfaceTreatment: r.articleSurfaceTreatment, colour: r.articleColour })
            : null,
          moReference: isLego
            ? legoReference(r.moOrderNumber, r.moOperationSequenceNo!, r.moOperationDescription)
            : null,
          setupPrice: r.setupPrice,
          netWeightKg:
            isLego && r.moShowNetWeight && r.articleWeight !== null
              ? Number(r.articleWeight) * Number(r.quantityOrdered)
              : null,
          // Only a date that differs from the header's is worth a line.
          requestedDeliveryDate:
            r.expectedDeliveryDate && r.expectedDeliveryDate !== order.expectedDeliveryDate
              ? r.expectedDeliveryDate
              : null,
        };
      }),
      showTotal: true,
      requestedDeliveryDate: order.expectedDeliveryDate,
      revision: showOrderRevisionOnDocuments ? order.revision : null,
      yourReference: order.yourReference,
      ourReference: order.ourReference,
      deliveryTerm: termLabel(order.deliveryTermCode, order.deliveryTermName),
      paymentTerm: termLabel(order.paymentTermCode, order.paymentTermName),
      carrier: termLabel(order.carrierCode, order.carrierName),
      carrierCustomerNumber,
      // Live value — no snapshot, same rule as the supplier address block.
      ourCustomerNumberAtSupplier: supplier!.ourCustomerNumber,
    });
    return { filename: `${order.orderNumber}.pdf`, content };
  }
  // Referenced base-data entries must exist — validated here so the API
  // answers 404 instead of surfacing an FK violation.
  async function validateRegisterRefs(input: {
    deliveryTermId?: string | null;
    paymentTermId?: string | null;
    carrierId?: string | null;
  }) {
    if (input.deliveryTermId && !(await registers.deliveryTerms.exists(input.deliveryTermId)))
      throw new RegisterEntryNotFoundError(input.deliveryTermId);
    if (input.paymentTermId && !(await registers.paymentTerms.exists(input.paymentTermId)))
      throw new RegisterEntryNotFoundError(input.paymentTermId);
    if (input.carrierId && !(await registers.carriers.exists(input.carrierId)))
      throw new RegisterEntryNotFoundError(input.carrierId);
  }

  // Momskoder: the supplier's Momskod (förval) as the card shows it — its own
  // code, else the one derived from its country (derived: true).
  function withDefaultVatCode<T extends { country: string; defaultVatCodeId: string | null }>(supplier: T, book: VatCodeBook) {
    const effective = supplierVatCode(book, supplier);
    return {
      ...supplier,
      defaultVatCode: effective ? { ...vatCodeRef(effective.row), derived: effective.derived } : null,
    };
  }

  // A supplier's own Momskod (förval) must be an active purchase code (both
  // or purchase direction) — the code a new supplier invoice starts from.
  // `current` is the supplier's stored code on an update: re-sending it
  // unchanged (the card saves the whole form) is allowed even when the code
  // has been deactivated since — the same rule as the supplier invoice's
  // header PATCH — so deactivating a code never locks a supplier card.
  async function validateDefaultVatCode(
    defaultVatCodeId: string | null | undefined,
    book: VatCodeBook,
    current: string | null = null
  ) {
    if (!defaultVatCodeId) return;
    documentVatCode(book, { id: defaultVatCodeId }, "purchase", { allowInactive: defaultVatCodeId === current });
  }

  return {
    async createSupplier(input: CreateSupplierInput) {
      await validateRegisterRefs(input);
      const book = await repo.vatCodeBook();
      await validateDefaultVatCode(input.defaultVatCodeId, book);
      const normalized = normalizeSupplierPaymentDetails(input);
      const problems = supplierPaymentDetailsProblems(paymentDetailsOf(normalized), paymentContextOf(normalized));
      if (Object.keys(problems).length > 0) throw new InvalidSupplierPaymentDetailsError(problems);
      try {
        return withDefaultVatCode(await repo.createSupplier(normalized), book);
      } catch (err) {
        // suppliers' only unique constraint is supplier_number, so a 23505
        // here can mean nothing else.
        if (isUniqueViolation(err)) throw new DuplicateSupplierNumberError(input.supplierNumber ?? "");
        throw err;
      }
    },

    async updateSupplier(id: string, input: UpdateSupplierInput) {
      await validateRegisterRefs(input);
      const book = await repo.vatCodeBook();
      // Read only when it matters: a code is being sent (unchanged may be
      // inactive) or the payment details need the merged state below.
      const touchesPayment =
        SUPPLIER_PAYMENT_DETAIL_KEYS.some((key) => input[key] !== undefined) || SUPPLIER_PAYMENT_CONTEXT_KEYS.some((key) => input[key] !== undefined);
      const needsExisting = Boolean(input.defaultVatCodeId) || touchesPayment;
      const existing = needsExisting ? await repo.findSupplierById(id) : null;
      await validateDefaultVatCode(input.defaultVatCodeId, book, existing?.defaultVatCodeId ?? null);
      const normalized = normalizeSupplierPaymentDetails(input);
      // The check runs on the MERGED state (stored row + patch), so a PATCH
      // that only switches the method is held against the stored numbers.
      if (touchesPayment) {
        if (!existing) throw new SupplierNotFoundError(id);
        const patch = stripUndefined(normalized);
        const merged = paymentDetailsOf({ ...paymentDetailsOf(existing), ...patch });
        const context = paymentContextOf({ ...paymentContextOf(existing), ...stripUndefined({ country: patch.country, address: patch.address, city: patch.city }) });
        const all = supplierPaymentDetailsProblems(merged, context);
        // A PATCH of only the address fields is held to the address rules
        // (street, town, country of a payee abroad) — a stored problem in the
        // payment details (an older, imported row) must not lock it.
        const paymentTouched = SUPPLIER_PAYMENT_DETAIL_KEYS.some((key) => normalized[key] !== undefined);
        const problems = paymentTouched
          ? all
          : Object.fromEntries(Object.entries(all).filter(([key]) => ["address", "city", "country", "paymentMethod"].includes(key)));
        if (Object.keys(problems).length > 0) throw new InvalidSupplierPaymentDetailsError(problems);
      }
      let row;
      try {
        row = await repo.updateSupplier(id, normalized);
      } catch (err) {
        if (isUniqueViolation(err)) throw new DuplicateSupplierNumberError(input.supplierNumber ?? "");
        throw err;
      }
      if (!row) throw new SupplierNotFoundError(id);
      return withDefaultVatCode(row, book);
    },

    // Momskoder: defaultVatCode { id, code, name, rate, derived } — the
    // supplier's Momskod (förval), derived from the country when it has none.
    async getSupplier(id: string) {
      const [supplier, book] = await Promise.all([repo.findSupplierById(id), repo.vatCodeBook()]);
      return supplier ? withDefaultVatCode(supplier, book) : null;
    },

    async listSupplierContacts(supplierId: string) {
      if (!(await repo.findSupplierById(supplierId))) throw new SupplierNotFoundError(supplierId);
      return repo.listSupplierContacts(supplierId);
    },

    async createSupplierContact(supplierId: string, input: CreateContactInput) {
      if (!(await repo.findSupplierById(supplierId))) throw new SupplierNotFoundError(supplierId);
      return repo.createSupplierContact(supplierId, input);
    },

    async updateSupplierContact(supplierId: string, contactId: string, input: UpdateContactInput) {
      const row = await repo.updateSupplierContact(supplierId, contactId, input);
      if (!row) throw new ContactNotFoundError(contactId);
      return row;
    },

    async deleteSupplierContact(supplierId: string, contactId: string) {
      const row = await repo.deleteSupplierContact(supplierId, contactId);
      if (!row) throw new ContactNotFoundError(contactId);
    },

    // --- Delivery addresses (leveransadresser) ---

    async listSupplierDeliveryAddresses(supplierId: string) {
      if (!(await repo.findSupplierById(supplierId))) throw new SupplierNotFoundError(supplierId);
      return repo.listSupplierDeliveryAddresses(supplierId);
    },

    async createSupplierDeliveryAddress(supplierId: string, input: CreateDeliveryAddressInput) {
      if (!(await repo.findSupplierById(supplierId))) throw new SupplierNotFoundError(supplierId);
      return repo.createSupplierDeliveryAddress(supplierId, input);
    },

    async updateSupplierDeliveryAddress(supplierId: string, addressId: string, input: UpdateDeliveryAddressInput) {
      const row = await repo.updateSupplierDeliveryAddress(supplierId, addressId, input);
      if (!row) throw new DeliveryAddressNotFoundError(addressId);
      return row;
    },

    async deleteSupplierDeliveryAddress(supplierId: string, addressId: string) {
      const row = await repo.deleteSupplierDeliveryAddress(supplierId, addressId);
      if (!row) throw new DeliveryAddressNotFoundError(addressId);
    },

    async listSuppliers(query: ListQuery) {
      return repo.listSuppliers(query);
    },

    async createPurchaseOrder(input: CreatePurchaseOrderInput, createdBy: string) {
      const supplier = await repo.findSupplierById(input.supplierId);
      if (!supplier) throw new SupplierNotFoundError(input.supplierId);
      return repo.createPurchaseOrder(input, createdBy, supplier.currency);
    },

    // Header fields (leveransdatum, notering, växelkurs, Er/Vår referens,
    // villkor) — same status rule as row editing:
    // draft/confirmed/partially_received. The currency stays locked to the
    // snapshot taken from the supplier at creation.
    async updatePurchaseOrderHeader(orderId: string, input: UpdatePurchaseOrderHeaderInput) {
      const order = await repo.findPurchaseOrderById(orderId);
      if (!order) throw new PurchaseOrderNotFoundError(orderId);
      if (order.status !== "draft" && order.status !== "confirmed" && order.status !== "partially_received") {
        throw new InvalidStatusTransitionError(`Cannot change the header of an order in status "${order.status}"`);
      }
      await validateRegisterRefs(input);
      await repo.updatePurchaseOrderHeader(orderId, input);
      return repo.findPurchaseOrderById(orderId);
    },

    // --- Inquiries (förfrågningar) — state machine:
    // draft → sent → answered → ordered, cancellable until ordered. ---

    async createInquiry(input: CreateInquiryInput, createdBy: string) {
      if (!(await repo.findSupplierById(input.supplierId))) throw new SupplierNotFoundError(input.supplierId);
      const rows = await Promise.all(
        input.rows.map(async (r) => ({ ...(await resolveRowInput(r)), ...(await resolveLegoRow(r)) }))
      );
      try {
        return await repo.createInquiry({ ...input, rows }, createdBy);
      } catch (err) {
        // inquiry_rows' only unique constraint is (inquiry_id, article_id) —
        // fires either from two rows in this same batch sharing an article,
        // or (for addInquiryRow) an article already on the inquiry.
        if (isUniqueViolation(err)) throw new DuplicateInquiryRowError();
        throw err;
      }
    },

    async listInquiries(query: ListInquiriesQuery) {
      return repo.listInquiries(query);
    },

    async getInquiry(id: string) {
      return repo.findInquiryById(id);
    },

    async listInquiryRows(inquiryId: string) {
      if (!(await repo.findInquiryById(inquiryId))) throw new InquiryNotFoundError(inquiryId);
      return repo.listInquiryRows(inquiryId);
    },

    // Rows stay editable through "answered" — that's when supplier prices
    // are filled in. Ordered/cancelled inquiries are frozen.
    async addInquiryRow(inquiryId: string, input: CreateInquiryRowInput) {
      const inquiry = await repo.findInquiryById(inquiryId);
      if (!inquiry) throw new InquiryNotFoundError(inquiryId);
      if (inquiry.status === "ordered" || inquiry.status === "cancelled") {
        throw new InvalidStatusTransitionError(`Cannot change rows on an inquiry in status "${inquiry.status}"`);
      }
      const row = { ...(await resolveRowInput(input)), ...(await resolveLegoRow(input)) };
      try {
        return await repo.addInquiryRow(inquiryId, row);
      } catch (err) {
        if (isUniqueViolation(err)) throw new DuplicateInquiryRowError();
        throw err;
      }
    },

    async updateInquiryRow(inquiryId: string, rowId: string, input: UpdateInquiryRowInput) {
      const inquiry = await repo.findInquiryById(inquiryId);
      if (!inquiry) throw new InquiryNotFoundError(inquiryId);
      if (inquiry.status === "ordered" || inquiry.status === "cancelled") {
        throw new InvalidStatusTransitionError(`Cannot change rows on an inquiry in status "${inquiry.status}"`);
      }

      const existing = await repo.findInquiryRow(inquiryId, rowId);
      if (!existing) throw new InquiryRowNotFoundError(rowId);
      // Ställpris belongs to lego rows only (the link itself is fixed).
      if (input.setupPrice != null && existing.moOperationId === null && existing.routingOperationId === null) {
        throw new NotLegoOperationError();
      }
      // The incoming quantity/price are in the newly chosen unit when the
      // PATCH sets one, otherwise in the row's current unit.
      let unitPatch: { unitId?: string | null; unitFactor?: number | null } = {};
      let factor = existing.unitFactor !== null ? Number(existing.unitFactor) : null;
      if (input.unitId !== undefined) {
        const selection = await articleFiles.resolveUnitSelection(existing.articleId, input.unitId);
        unitPatch = selection;
        factor = selection.unitFactor;
      }

      const row = await repo.updateInquiryRow(inquiryId, rowId, {
        ...unitPatch,
        quantity:
          input.quantity !== undefined
            ? await roundForArticle(existing.articleId, toBaseQuantity(input.quantity, factor))
            : undefined,
        unitPrice:
          input.unitPrice !== undefined && input.unitPrice !== null
            ? toBasePrice(input.unitPrice, factor)
            : input.unitPrice,
        // Per order, not per unit — no factor.
        setupPrice: input.setupPrice,
      });
      if (!row) throw new InquiryRowNotFoundError(rowId);
      return row;
    },

    async deleteInquiryRow(inquiryId: string, rowId: string) {
      const inquiry = await repo.findInquiryById(inquiryId);
      if (!inquiry) throw new InquiryNotFoundError(inquiryId);
      if (inquiry.status === "ordered" || inquiry.status === "cancelled") {
        throw new InvalidStatusTransitionError(`Cannot change rows on an inquiry in status "${inquiry.status}"`);
      }
      const row = await repo.deleteInquiryRow(inquiryId, rowId);
      if (!row) throw new InquiryRowNotFoundError(rowId);
    },

    // Terms on the inquiry header — same status rule as the rows.
    async updateInquiryHeader(inquiryId: string, input: UpdateInquiryHeaderInput) {
      const inquiry = await repo.findInquiryById(inquiryId);
      if (!inquiry) throw new InquiryNotFoundError(inquiryId);
      if (inquiry.status === "ordered" || inquiry.status === "cancelled") {
        throw new InvalidStatusTransitionError(`Cannot change the header of an inquiry in status "${inquiry.status}"`);
      }
      await validateRegisterRefs(input);
      await repo.updateInquiryHeader(inquiryId, input);
      return repo.findInquiryById(inquiryId);
    },

    async sendInquiry(id: string, userId?: string | null) {
      const inquiry = await repo.findInquiryById(id);
      if (!inquiry) throw new InquiryNotFoundError(id);
      if (inquiry.status !== "draft") {
        throw new InvalidStatusTransitionError(`Cannot send an inquiry in status "${inquiry.status}"`);
      }
      const updated = await repo.updateInquiryStatus(id, "sent");
      await audit.log({
        entityType: "inquiry",
        entityId: inquiry.inquiryNumber,
        action: "sent",
        userId: userId ?? null,
      });
      return updated;
    },

    async getInquiryPdf(id: string) {
      const inquiry = await repo.findInquiryById(id);
      if (!inquiry) throw new InquiryNotFoundError(id);
      return renderInquiryPdf(inquiry);
    },

    // Emails the inquiry as a PDF attachment. Sending is what "skickad"
    // means, so a draft transitions to sent — but only when SMTP succeeded
    // (sendMail throws otherwise). Later statuses are plain resends.
    async sendInquiryEmail(id: string, input: SendDocumentEmailInput) {
      const inquiry = await repo.findInquiryById(id);
      if (!inquiry) throw new InquiryNotFoundError(id);
      if (inquiry.status === "ordered" || inquiry.status === "cancelled") {
        throw new InvalidStatusTransitionError(`Cannot email an inquiry in status "${inquiry.status}"`);
      }
      const attachment = await renderInquiryPdf(inquiry);
      // Lego rows' drawings always ride along, exactly like the IO's.
      const extra = await legoAwareAttachments(
        await repo.subcontractDrawingSources({ inquiryId: id }),
        (await repo.listInquiryRows(id)).map((r) => r.articleId),
        input.attachDrawings
      );
      await mail.sendMail({
        documentType: "inquiry",
        documentId: id,
        to: input.to,
        subject: input.subject,
        message: input.message,
        attachments: dedupeAttachmentFilenames([attachment, ...extra]),
        attachDrawings: input.attachDrawings,
      });
      if (inquiry.status === "draft") return repo.updateInquiryStatus(id, "sent");
      return inquiry;
    },

    async markInquiryAnswered(id: string, userId?: string | null) {
      const inquiry = await repo.findInquiryById(id);
      if (!inquiry) throw new InquiryNotFoundError(id);
      if (inquiry.status !== "sent") {
        throw new InvalidStatusTransitionError(`Cannot mark an inquiry in status "${inquiry.status}" as answered`);
      }
      const updated = await repo.updateInquiryStatus(id, "answered");
      await audit.log({
        entityType: "inquiry",
        entityId: inquiry.inquiryNumber,
        action: "answered",
        userId: userId ?? null,
      });
      return updated;
    },

    async cancelInquiry(id: string, userId?: string | null) {
      const inquiry = await repo.findInquiryById(id);
      if (!inquiry) throw new InquiryNotFoundError(id);
      if (inquiry.status === "ordered" || inquiry.status === "cancelled") {
        throw new InvalidStatusTransitionError(`Cannot cancel an inquiry in status "${inquiry.status}"`);
      }
      const updated = await repo.updateInquiryStatus(id, "cancelled");
      await audit.log({
        entityType: "inquiry",
        entityId: inquiry.inquiryNumber,
        action: "cancelled",
        userId: userId ?? null,
      });
      return updated;
    },

    async convertInquiryToOrder(id: string, createdBy: string) {
      const inquiry = await repo.findInquiryById(id);
      if (!inquiry) throw new InquiryNotFoundError(id);
      if (inquiry.status !== "sent" && inquiry.status !== "answered") {
        throw new InvalidStatusTransitionError(
          `Cannot convert an inquiry in status "${inquiry.status}" to a purchase order`
        );
      }
      const order = await repo.convertInquiryToOrder(id, createdBy);
      if (!order) throw new InquiryNotFoundError(id);
      return order;
    },

    // "Uppdatera beredningens legopris" — writes the answered unit price,
    // the row's ställpris and the inquiry's supplier to the article's
    // routing operation. Explicit button, never automatic: a routing price
    // is the calculation's input and must be a deliberate choice. Allowed
    // once the price is final (answered, or already ordered).
    async applyInquiryRowPriceToRouting(inquiryId: string, rowId: string, userId?: string | null) {
      const inquiry = await repo.findInquiryById(inquiryId);
      if (!inquiry) throw new InquiryNotFoundError(inquiryId);
      const row = await repo.findInquiryRow(inquiryId, rowId);
      if (!row) throw new InquiryRowNotFoundError(rowId);
      if (row.moOperationId === null && row.routingOperationId === null) {
        throw new InquiryRowPriceNotApplicableError("Raden är ingen legorad");
      }
      if (inquiry.status !== "answered" && inquiry.status !== "ordered") {
        throw new InquiryRowPriceNotApplicableError(
          `Priset kan bara föras över från en besvarad förfrågan (status "${inquiry.status}")`
        );
      }
      if (row.unitPrice === null) throw new InquiryRowPriceNotApplicableError("Raden saknar pris");
      if (row.routingOperationId === null) {
        throw new InquiryRowPriceNotApplicableError("Beredningsoperationen finns inte längre");
      }

      // Row prices are stored per base unit, which is what the routing
      // operation's unit price means too. The manufacturing service's own
      // errors are matched by name — this module must not import it.
      let updated: unknown;
      try {
        updated = await manufacturing.updateRoutingOperation(row.articleId, row.routingOperationId, {
          unitPrice: Number(row.unitPrice),
          setupPrice: row.setupPrice !== null ? Number(row.setupPrice) : null,
          subcontractSupplierId: inquiry.supplierId,
        });
      } catch (err) {
        if (err instanceof Error && err.name === "NotSubcontractOperationError") {
          throw new InquiryRowPriceNotApplicableError("Beredningsoperationen ligger inte längre på en legoresurs");
        }
        if (err instanceof Error && err.name === "RoutingOperationNotFoundError") {
          throw new InquiryRowPriceNotApplicableError("Beredningsoperationen finns inte längre");
        }
        throw err;
      }
      await audit.log({
        entityType: "inquiry",
        entityId: inquiry.inquiryNumber,
        action: "price_applied_to_routing",
        detail: {
          routingOperationId: row.routingOperationId,
          unitPrice: row.unitPrice,
          setupPrice: row.setupPrice,
          supplierId: inquiry.supplierId,
        },
        userId: userId ?? null,
      });
      return updated;
    },

    async getPurchaseOrder(id: string) {
      return repo.findPurchaseOrderById(id);
    },

    async listPurchaseOrders(query: ListPurchaseOrdersQuery) {
      return repo.listPurchaseOrders(query);
    },

    async listRows(purchaseOrderId: string) {
      return repo.listRowsByOrder(purchaseOrderId);
    },

    // Article FK is enforced by the DB (same precedent as the stock module,
    // which doesn't pre-check articleId either) — no cross-module lookup here.
    // Rows are editable until the order is fully received/closed/cancelled.
    async addRow(purchaseOrderId: string, input: CreatePurchaseOrderRowInput, userId?: string | null) {
      const order = await repo.findPurchaseOrderById(purchaseOrderId);
      if (!order) throw new PurchaseOrderNotFoundError(purchaseOrderId);
      if (order.status !== "draft" && order.status !== "confirmed" && order.status !== "partially_received") {
        throw new InvalidStatusTransitionError(`Cannot add rows to an order in status "${order.status}"`);
      }
      let row;
      try {
        row = await repo.addRow(purchaseOrderId, await resolveRowInput(input));
      } catch (err) {
        // Lego row pointing at an unknown MO operation — the hand-declared
        // FK is the existence check.
        if (isForeignKeyViolation(err, "purchase_order_rows_mo_operation_id_mo_operations_id_fk")) {
          throw new MoOperationNotFoundError(input.moOperationId ?? "");
        }
        throw err;
      }
      const article = await articleFiles.getArticle(row.articleId);
      await audit.log({
        entityType: "purchase_order_row",
        entityId: order.orderNumber,
        action: "row_added",
        detail: {
          articleNumber: article?.articleNumber ?? null,
          quantity: row.quantityOrdered,
          unitPrice: row.unitPrice,
        },
        userId: userId ?? null,
      });
      return row;
    },

    async updateRow(purchaseOrderId: string, rowId: string, input: UpdatePurchaseOrderRowInput, userId?: string | null) {
      const order = await repo.findPurchaseOrderById(purchaseOrderId);
      if (!order) throw new PurchaseOrderNotFoundError(purchaseOrderId);
      if (order.status !== "draft" && order.status !== "confirmed" && order.status !== "partially_received") {
        throw new InvalidStatusTransitionError(`Cannot change rows on an order in status "${order.status}"`);
      }

      const existing = await repo.findRowById(rowId);
      if (!existing || existing.purchaseOrderId !== purchaseOrderId) throw new PurchaseOrderRowNotFoundError(rowId);
      // The incoming quantity/price are in the newly chosen unit when the
      // PATCH sets one, otherwise in the row's current unit.
      let unitPatch: { unitId?: string | null; unitFactor?: number | null } = {};
      let factor = existing.unitFactor !== null ? Number(existing.unitFactor) : null;
      if (input.unitId !== undefined) {
        const selection = await articleFiles.resolveUnitSelection(existing.articleId, input.unitId);
        unitPatch = selection;
        factor = selection.unitFactor;
      }

      const result = await repo.updateRow(
        purchaseOrderId,
        rowId,
        {
          ...unitPatch,
          quantity:
            input.quantity !== undefined
              ? await roundForArticle(existing.articleId, toBaseQuantity(input.quantity, factor))
              : undefined,
          unitPrice: input.unitPrice !== undefined ? toBasePrice(input.unitPrice, factor) : undefined,
          // Ställpris is entered per row (not per unit) — no unit conversion.
          setupPrice: input.setupPrice,
          expectedDeliveryDate: input.expectedDeliveryDate,
          confirmedDeliveryDate: input.confirmedDeliveryDate,
        },
        input.bumpRevision !== false
      );
      if (result.ok) {
        const article = await articleFiles.getArticle(existing.articleId);
        const updated = result.row!;
        // The row's own dates only when they changed (the card always sends
        // them) — the quantity/price pair stays the entry's fixed core.
        const requestedChanged = existing.expectedDeliveryDate !== updated.expectedDeliveryDate;
        const confirmedChanged = existing.confirmedDeliveryDate !== updated.confirmedDeliveryDate;
        const dates = (r: typeof updated) => ({
          ...(requestedChanged ? { requestedDeliveryDate: r.expectedDeliveryDate } : {}),
          ...(confirmedChanged ? { confirmedDeliveryDate: r.confirmedDeliveryDate } : {}),
        });
        await audit.log({
          entityType: "purchase_order_row",
          entityId: order.orderNumber,
          action: "row_updated",
          detail: {
            articleNumber: article?.articleNumber ?? null,
            before: { quantity: existing.quantityOrdered, unitPrice: existing.unitPrice, ...dates(existing) },
            after: { quantity: updated.quantityOrdered, unitPrice: updated.unitPrice, ...dates(updated) },
          },
          userId: userId ?? null,
        });
        return { row: result.row!, orderStatus: result.orderStatus };
      }
      switch (result.reason) {
        case "row_not_found":
          throw new PurchaseOrderRowNotFoundError(rowId);
        case "quantity_below_received":
          throw new OverReceiptError();
        case "row_has_receipts":
          throw new RowHasReceiptsError();
      }
    },

    async deleteRow(purchaseOrderId: string, rowId: string, bumpRevision = true, userId?: string | null) {
      const order = await repo.findPurchaseOrderById(purchaseOrderId);
      if (!order) throw new PurchaseOrderNotFoundError(purchaseOrderId);
      if (order.status !== "draft" && order.status !== "confirmed" && order.status !== "partially_received") {
        throw new InvalidStatusTransitionError(`Cannot change rows on an order in status "${order.status}"`);
      }
      const existing = await repo.findRowById(rowId);
      const result = await repo.deleteRow(purchaseOrderId, rowId, bumpRevision);
      if (result.ok) {
        const article = existing ? await articleFiles.getArticle(existing.articleId) : null;
        await audit.log({
          entityType: "purchase_order_row",
          entityId: order.orderNumber,
          action: "row_deleted",
          detail: existing
            ? { articleNumber: article?.articleNumber ?? null, quantity: existing.quantityOrdered, unitPrice: existing.unitPrice }
            : null,
          userId: userId ?? null,
        });
        return { orderStatus: result.orderStatus };
      }
      switch (result.reason) {
        case "row_not_found":
          throw new PurchaseOrderRowNotFoundError(rowId);
        case "quantity_below_received":
          throw new OverReceiptError();
        case "row_has_receipts":
          throw new RowHasReceiptsError();
      }
    },

    async confirm(orderId: string, userId?: string | null) {
      const order = await repo.findPurchaseOrderById(orderId);
      if (!order) throw new PurchaseOrderNotFoundError(orderId);
      if (order.status !== "draft") {
        throw new InvalidStatusTransitionError(`Cannot confirm an order in status "${order.status}"`);
      }
      const updated = await repo.updateStatus(orderId, "confirmed");
      await audit.log({
        entityType: "purchase_order",
        entityId: order.orderNumber,
        action: "confirmed",
        userId: userId ?? null,
      });
      return updated;
    },

    async getPurchaseOrderPdf(orderId: string) {
      const order = await repo.findPurchaseOrderById(orderId);
      if (!order) throw new PurchaseOrderNotFoundError(orderId);
      return renderPurchaseOrderPdf(order);
    },

    // Several orders as one document, in the order the ids were given — the
    // behovsberäkning prints every IO it just created in one go. Rendered
    // one at a time (each render loads supplier/rows/settings itself); an
    // unknown id fails the whole batch rather than silently dropping out.
    async getPurchaseOrdersPdf(orderIds: string[]) {
      const documents: Buffer[] = [];
      for (const orderId of orderIds) {
        documents.push((await this.getPurchaseOrderPdf(orderId)).content);
      }
      return { filename: `inkopsordrar-${orderIds.length}-st.pdf`, content: await mergePdfs(documents) };
    },

    // Emails the order as a PDF attachment. Sending a draft to the supplier
    // is the act of ordering, so it transitions draft → confirmed — only
    // when SMTP succeeded. Later statuses are plain resends.
    // Lego rows' drawings are ALWAYS attached (the subcontractor cannot work
    // without them): the article's own drawings when the operation says
    // "use article drawings", otherwise the file uploaded on the operation.
    // The attachDrawings checkbox keeps governing the other rows only.
    async sendPurchaseOrderEmail(orderId: string, input: SendDocumentEmailInput) {
      const order = await repo.findPurchaseOrderById(orderId);
      if (!order) throw new PurchaseOrderNotFoundError(orderId);
      if (order.status === "cancelled" || order.status === "closed") {
        throw new InvalidStatusTransitionError(`Cannot email an order in status "${order.status}"`);
      }
      const attachment = await renderPurchaseOrderPdf(order);

      const extra = await legoAwareAttachments(
        await repo.subcontractDrawingSources({ purchaseOrderId: orderId }),
        (await repo.listRowsByOrder(orderId)).map((r) => r.articleId),
        input.attachDrawings
      );

      await mail.sendMail({
        documentType: "purchase_order",
        documentId: orderId,
        to: input.to,
        subject: input.subject,
        message: input.message,
        attachments: dedupeAttachmentFilenames([attachment, ...extra]),
        attachDrawings: input.attachDrawings,
      });
      if (order.status === "draft") return repo.updateStatus(orderId, "confirmed");
      return order;
    },

    async cancel(orderId: string, userId?: string | null) {
      const order = await repo.findPurchaseOrderById(orderId);
      if (!order) throw new PurchaseOrderNotFoundError(orderId);
      if (order.status !== "draft" && order.status !== "confirmed") {
        throw new InvalidStatusTransitionError(
          `Cannot cancel an order in status "${order.status}" — goods have already been received`
        );
      }
      const updated = await repo.updateStatus(orderId, "cancelled");
      await audit.log({
        entityType: "purchase_order",
        entityId: order.orderNumber,
        action: "cancelled",
        userId: userId ?? null,
      });
      return updated;
    },

    async close(orderId: string, userId?: string | null) {
      const order = await repo.findPurchaseOrderById(orderId);
      if (!order) throw new PurchaseOrderNotFoundError(orderId);
      if (order.status !== "received") {
        throw new InvalidStatusTransitionError(`Cannot close an order in status "${order.status}"`);
      }
      const updated = await repo.updateStatus(orderId, "closed");
      await audit.log({
        entityType: "purchase_order",
        entityId: order.orderNumber,
        action: "closed",
        userId: userId ?? null,
      });
      return updated;
    },

    // Manual status override (Monitor-style): any status, any direction —
    // deliberately no transition guard. Never books stock and does not bump
    // the revision (the order's content is unchanged).
    async setStatus(orderId: string, status: PurchaseOrderStatus, userId?: string | null) {
      const order = await repo.findPurchaseOrderById(orderId);
      if (!order) throw new PurchaseOrderNotFoundError(orderId);
      await repo.updateStatus(orderId, status);
      await audit.log({
        entityType: "purchase_order",
        entityId: order.orderNumber,
        action: "status_set",
        detail: { before: order.status, after: status },
        userId: userId ?? null,
      });
      return repo.findPurchaseOrderById(orderId);
    },

    async receiveGoods(orderId: string, rowId: string, input: ReceiveGoodsInput, createdBy: string) {
      // Read outside the receipt's transaction: a settings change racing a
      // receipt may go either way, which is fine for a tolerance.
      const { purchaseOverReceiptPercent } = await settings.getSettings();
      // Lego row, Materialbrist: the receipt commits before the operation
      // report (below), so a shortage the user should be asked about has to
      // surface before anything is booked. Which modes ask is the
      // manufacturing module's decision; a refusal inside the report itself
      // comes back as the operationReport warning like any other failure.
      // Asked only when the receipt itself would go through — otherwise the
      // user would confirm a shortage and then get the status/over-receipt
      // refusal anyway (the receipt's own transaction re-checks both).
      const existingRow = await repo.findRowById(rowId);
      if (existingRow?.purchaseOrderId === orderId && existingRow.moOperationId !== null) {
        const order = await repo.findPurchaseOrderById(orderId);
        const openForReceipt = order?.status === "confirmed" || order?.status === "partially_received";
        const withinLimit =
          purchaseOverReceiptPercent === null ||
          Number(existingRow.quantityReceived) + input.quantity <=
            Number(existingRow.quantityOrdered) * (1 + purchaseOverReceiptPercent / 100) + 0.00005;
        if (openForReceipt && withinLimit) {
          await manufacturing.assertMaterialBeforeSubcontractReceipt(
            existingRow.moOperationId,
            input.quantity,
            input.allowMaterialShortage
          );
        }
      }
      const result = await repo.receiveGoods(orderId, rowId, {
        locationId: input.locationId,
        quantity: input.quantity,
        createdBy,
        overReceiptPercent: purchaseOverReceiptPercent,
      });
      if (result.ok) {
        const [order, article] = await Promise.all([
          repo.findPurchaseOrderById(orderId),
          articleFiles.getArticle(result.row.articleId),
        ]);
        await audit.log({
          entityType: "purchase_order_row",
          entityId: order?.orderNumber ?? orderId,
          action: "goods_received",
          detail: { articleNumber: article?.articleNumber ?? null, quantity: input.quantity },
          userId: createdBy,
        });
        // Lego row: the receipt is what "the operation happened" means, so
        // it auto-reports the linked MO operation — every receipt reports the
        // received quantity, and the operation only flips to done once
        // accumulated quantity_completed covers the MO's order quantity (see
        // markDoneWhenCovered below), so a manually shorted row leaves it
        // pending. Runs AFTER the receipt's own committed transaction: a TO
        // in the wrong status (done/closed, or already manually reported)
        // must never undo the goods receipt, so failures come back as a
        // warning instead of an error. Linked material tops up via the
        // ordinary consumeLinkedMaterial path.
        let operationReport: OperationReportOutcome | undefined;
        let reportId: string | null = null;
        if (result.row.moOperationId !== null) {
          try {
            // A fully-received IO row doesn't by itself mean the operation is
            // done — a manually shorted row (50 of the MO's 100) must leave
            // the operation pending so the remaining 50 stay in the planning
            // proposals. The coverage decision (accumulated quantity_completed
            // vs. the MO's order quantity) is made on the manufacturing side,
            // which already has the order quantity loaded under the row lock.
            ({ reportId } = await manufacturing.reportOperationQuantities(result.row.moOperationId, {
              quantityOk: input.quantity,
              quantityScrapped: 0,
              markDone: false,
              markDoneWhenCovered: true,
              createdBy,
              source: "purchase_receipt",
              purchaseOrderId: orderId,
              allowMaterialShortage: input.allowMaterialShortage,
            }));
            operationReport = { ok: true };
          } catch (err) {
            operationReport = {
              ok: false,
              message: err instanceof Error ? err.message : "Operationen kunde inte avrapporteras",
            };
          }
        }
        // Ångra inleverans undoes the TO report together with the receipt.
        // Outside the try above: the report stands either way, so a failed
        // link must not read as a failed report. (An undo that lands before
        // the link is written reverses only the IO side — a window of one
        // report call.)
        if (reportId !== null) await repo.linkReceiptReport(result.receiptId, reportId);
        return { row: result.row, orderStatus: result.orderStatus, operationReport };
      }

      switch (result.reason) {
        case "order_not_found":
          throw new PurchaseOrderNotFoundError(orderId);
        case "row_not_found":
          throw new PurchaseOrderRowNotFoundError(rowId);
        case "invalid_status":
          throw new InvalidStatusTransitionError("Goods can only be received against a confirmed or partially received order");
        case "over_receipt":
          throw new OverReceiptError({
            allowedPercent: purchaseOverReceiptPercent ?? 0,
            maxQuantity: result.maxQuantity,
          });
      }
    },

    // Inleveranser on the IO card (undone ones included, newest first).
    async listReceipts(orderId: string) {
      if (!(await repo.findPurchaseOrderById(orderId))) throw new PurchaseOrderNotFoundError(orderId);
      return repo.listReceipts(orderId);
    },

    // Ångra inleverans: reverses one receipt — goods out of stock again (or,
    // on a lego row, the TO report it made), the row's received quantity and
    // the order status. All in one transaction; see repo.undoReceipt.
    async undoReceipt(orderId: string, receiptId: string, userId: string) {
      let afterCommit: (() => Promise<void>) | null = null;
      const result = await repo.undoReceipt(orderId, receiptId, {
        undoneBy: userId,
        undoLinkedReport: async (tx, moReportId) => {
          try {
            afterCommit = await manufacturing.undoPurchaseReceiptReportInTx(tx, moReportId, userId);
          } catch (err) {
            if (err instanceof MoInvalidStatusTransitionError) throw new PurchaseReceiptManufacturingOrderLockedError();
            throw err;
          }
        },
      });
      if (!result.ok) {
        switch (result.reason) {
          case "receipt_not_found":
            throw new PurchaseReceiptNotFoundError(receiptId);
          case "already_undone":
            throw new PurchaseReceiptAlreadyUndoneError();
          case "invalid_status":
            throw new InvalidStatusTransitionError(
              "Receipts can only be undone while the order is partially received or received"
            );
          case "insufficient_stock":
            throw new PurchaseReceiptStockMissingError(result.available, result.required);
        }
      }

      const [order, article] = await Promise.all([
        repo.findPurchaseOrderById(orderId),
        articleFiles.getArticle(result.row.articleId),
      ]);
      await audit.log({
        entityType: "purchase_order_row",
        entityId: order?.orderNumber ?? orderId,
        action: "goods_receipt_undone",
        detail: {
          articleNumber: article?.articleNumber ?? null,
          quantity: Number(result.receipt.quantity),
          receivedAt: result.receipt.createdAt,
          ...(result.statusBefore !== result.orderStatus
            ? { statusBefore: result.statusBefore, statusAfter: result.orderStatus }
            : {}),
        },
        userId,
      });
      if (afterCommit) await (afterCommit as () => Promise<void>)();
      return { row: result.row, orderStatus: result.orderStatus };
    },

    // --- Article supplier catalog (leverantörskatalog per artikel) ---

    async listArticleSuppliers(articleId: string) {
      if (!(await articleFiles.getArticle(articleId))) throw new ArticleNotFoundError(articleId);
      return repo.listArticleSuppliers(articleId);
    },

    async addArticleSupplier(articleId: string, input: CreateArticleSupplierInput) {
      if (!(await articleFiles.getArticle(articleId))) throw new ArticleNotFoundError(articleId);
      const supplier = await repo.findSupplierById(input.supplierId);
      if (!supplier) throw new SupplierNotFoundError(input.supplierId);
      if (!supplier.active) throw new SupplierInactiveError(input.supplierId);
      try {
        return await repo.createArticleSupplier(articleId, input);
      } catch (err) {
        if (isUniqueViolation(err)) throw new DuplicateArticleSupplierError();
        throw err;
      }
    },

    async updateArticleSupplier(articleId: string, rowId: string, input: UpdateArticleSupplierInput) {
      const row = await repo.updateArticleSupplier(articleId, rowId, input);
      if (!row) throw new ArticleSupplierNotFoundError(rowId);
      return row;
    },

    async removeArticleSupplier(articleId: string, rowId: string) {
      const row = await repo.deleteArticleSupplier(articleId, rowId);
      if (!row) throw new ArticleSupplierNotFoundError(rowId);
    },

    // Stafflat leverantörspris for one supplier/article/quantity (base unit)
    // — the purchase order card's à-pris prefill. null = unknown article;
    // `price: null` = the supplier has no catalog row or no price.
    async getSupplierPriceQuote(query: SupplierPriceQuoteQuery): Promise<SupplierPriceQuote | null> {
      const article = await articleFiles.getArticle(query.articleId);
      if (!article) return null;
      const row = await repo.findArticleSupplierBySupplier(query.articleId, query.supplierId);
      if (!row) return { articleNumber: article.articleNumber, price: null };
      const resolved = resolveSupplierPrice(
        { price: row.price === null ? null : Number(row.price), priceBreaks: row.priceBreaks },
        query.quantity
      );
      return {
        articleNumber: article.articleNumber,
        price:
          resolved.price === null
            ? null
            : { unitPrice: resolved.price, currency: row.currency, fromQuantity: resolved.fromQuantity!, source: resolved.source! },
      };
    },

    // Fasta leveransdagar: the suggested Önskat leveransdatum (an ARRIVAL
    // date) — without articleId for the order header (only when the
    // supplier has fixed days), with it for a row (the catalog row's lead
    // time; null via the short-circuit when there are no days, lead time or
    // transit). `warning` checks q.date against the supplier's days. null =
    // unknown supplier.
    async getSupplierDeliveryDateSuggestion(
      q: SupplierDeliveryDateQuery,
      today: string = stockholmToday()
    ): Promise<SupplierDeliveryDateSuggestion | null> {
      const supplier = await repo.findSupplierById(q.supplierId);
      if (!supplier) return null;
      const catalogRow = q.articleId ? await repo.findArticleSupplierBySupplier(q.articleId, q.supplierId) : null;
      const leadTimeDays = q.articleId ? (catalogRow?.leadTimeDays ?? null) : null;
      const { defaults, offDays } = await repo.deliveryContext(
        deliveryHolidayWindow([today, q.date ?? today], (leadTimeDays ?? 0) + 60)
      );
      const settings = effectiveDeliverySettings(supplier, "supplier", defaults);
      const suggest = () =>
        suggestPurchaseDeliveryDate({ demandDate: null, today, leadTimeDays: leadTimeDays ?? 0, settings, offDays }).date;
      const date = q.articleId ? suggest() : settings.weekdays.length > 0 ? suggest() : null;
      return {
        date,
        leadTimeDays,
        settings,
        summary: deliverySummary("supplier", settings),
        warning: q.date ? deliveryDateWarning("supplier", q.date, settings, offDays) : null,
      };
    },

    // --- Per-article purchase logs (read-only) ---

    async listArticleGoodsReceipts(articleId: string, query: ListGoodsReceiptsQuery) {
      return repo.listGoodsReceiptsByArticle(articleId, query);
    },

    async listArticlePriceHistory(articleId: string, query: ListPriceHistoryQuery) {
      return repo.listPriceHistoryByArticle(articleId, query);
    },

    // Fakturaunderlag — inlevererade order som väntar på leverantörsfaktura.
    async listInvoiceBasis(query: ListPurchaseInvoiceBasisQuery) {
      return repo.listInvoiceBasis(query);
    },
  };
}

export type PurchaseService = ReturnType<typeof createPurchaseService>;

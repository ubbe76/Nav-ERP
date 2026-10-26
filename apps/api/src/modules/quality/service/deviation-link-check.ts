import type { DeviationLinkDocumentType, DeviationType } from "@navet/shared";

// Avvikelsens kopplingskontroller — pure. The repository loads the facts of
// every referenced document (null = not found); this decides whether they
// belong together with the case and with each other, and fills in what can
// be derived (the order of a chosen row, the TO of a chosen operation, the
// article of a chosen row/TO). The first problem is returned with the field
// the web marks (400 deviation-link-mismatch).

export interface DeviationLinkInput {
  type: DeviationType;
  customerId: string | null;
  supplierId: string | null;
  salesOrderId: string | null;
  salesOrderRowId: string | null;
  invoiceId: string | null;
  purchaseOrderId: string | null;
  purchaseOrderRowId: string | null;
  manufacturingOrderId: string | null;
  moOperationId: string | null;
  articleId: string | null;
}

// undefined = the id was not given (nothing loaded); null = given but missing.
export interface DeviationLinkFacts {
  customerExists?: boolean;
  supplierExists?: boolean;
  articleExists?: boolean;
  salesOrder?: { customerId: string; orderNumber: string } | null;
  salesOrderRow?: { salesOrderId: string; articleId: string | null } | null;
  invoice?: { customerId: string; invoiceNumber: string | null } | null;
  purchaseOrder?: { supplierId: string; orderNumber: string } | null;
  purchaseOrderRow?: { purchaseOrderId: string; articleId: string | null } | null;
  manufacturingOrder?: { articleId: string; orderNumber: string } | null;
  moOperation?: { manufacturingOrderId: string } | null;
}

export type DeviationLinkCheck =
  | { ok: true; resolved: DeviationLinkInput }
  | { ok: false; field: keyof DeviationLinkInput; message: string };

const TYPE_TEXT: Record<DeviationType, string> = {
  customer: "en kundreklamation",
  supplier: "en leverantörsavvikelse",
  internal: "en intern avvikelse",
};

// The parent ids a row/operation implies — what the repository must load
// the order facts for when only the row was given.
export function impliedParents(
  input: Pick<DeviationLinkInput, "salesOrderId" | "purchaseOrderId" | "manufacturingOrderId">,
  facts: Pick<DeviationLinkFacts, "salesOrderRow" | "purchaseOrderRow" | "moOperation">
) {
  return {
    salesOrderId: input.salesOrderId ?? facts.salesOrderRow?.salesOrderId ?? null,
    purchaseOrderId: input.purchaseOrderId ?? facts.purchaseOrderRow?.purchaseOrderId ?? null,
    manufacturingOrderId: input.manufacturingOrderId ?? facts.moOperation?.manufacturingOrderId ?? null,
  };
}

export function checkDeviationLinks(input: DeviationLinkInput, facts: DeviationLinkFacts): DeviationLinkCheck {
  const fail = (field: keyof DeviationLinkInput, message: string): DeviationLinkCheck => ({ ok: false, field, message });
  const r: DeviationLinkInput = { ...input };

  // The case's type decides the counterparty and which documents fit.
  if (r.type === "customer" && !r.customerId) return fail("customerId", "Välj kund för en kundreklamation");
  if (r.type === "supplier" && !r.supplierId) return fail("supplierId", "Välj leverantör för en leverantörsavvikelse");
  const notForType = (field: keyof DeviationLinkInput, what: string) =>
    fail(field, `${what} kan inte kopplas till ${TYPE_TEXT[r.type]}`);
  if (r.type !== "customer") {
    if (r.customerId) return notForType("customerId", "En kund");
    if (r.salesOrderId) return notForType("salesOrderId", "En kundorder");
    if (r.salesOrderRowId) return notForType("salesOrderRowId", "En kundorderrad");
    if (r.invoiceId) return notForType("invoiceId", "En kundfaktura");
  }
  if (r.type !== "supplier") {
    if (r.supplierId) return notForType("supplierId", "En leverantör");
    if (r.purchaseOrderId) return notForType("purchaseOrderId", "En inköpsorder");
    if (r.purchaseOrderRowId) return notForType("purchaseOrderRowId", "En inköpsorderrad");
  }

  // Existence of everything given.
  if (r.customerId && facts.customerExists === false) return fail("customerId", "Kunden finns inte");
  if (r.supplierId && facts.supplierExists === false) return fail("supplierId", "Leverantören finns inte");
  if (r.articleId && facts.articleExists === false) return fail("articleId", "Artikeln finns inte");
  if (r.salesOrderRowId && !facts.salesOrderRow) return fail("salesOrderRowId", "Kundorderraden finns inte");
  if (r.purchaseOrderRowId && !facts.purchaseOrderRow) return fail("purchaseOrderRowId", "Inköpsorderraden finns inte");
  if (r.moOperationId && !facts.moOperation) return fail("moOperationId", "Operationen finns inte");
  if (r.invoiceId && !facts.invoice) return fail("invoiceId", "Fakturan finns inte");

  // A row or an operation implies its order; a given order must be the same.
  if (facts.salesOrderRow) {
    if (r.salesOrderId && r.salesOrderId !== facts.salesOrderRow.salesOrderId) {
      return fail("salesOrderRowId", "Kundorderraden tillhör en annan kundorder");
    }
    r.salesOrderId = facts.salesOrderRow.salesOrderId;
  }
  if (facts.purchaseOrderRow) {
    if (r.purchaseOrderId && r.purchaseOrderId !== facts.purchaseOrderRow.purchaseOrderId) {
      return fail("purchaseOrderRowId", "Inköpsorderraden tillhör en annan inköpsorder");
    }
    r.purchaseOrderId = facts.purchaseOrderRow.purchaseOrderId;
  }
  if (facts.moOperation) {
    if (r.manufacturingOrderId && r.manufacturingOrderId !== facts.moOperation.manufacturingOrderId) {
      return fail("moOperationId", "Operationen tillhör en annan tillverkningsorder");
    }
    r.manufacturingOrderId = facts.moOperation.manufacturingOrderId;
  }
  if (r.salesOrderId && !facts.salesOrder) return fail("salesOrderId", "Kundordern finns inte");
  if (r.purchaseOrderId && !facts.purchaseOrder) return fail("purchaseOrderId", "Inköpsordern finns inte");
  if (r.manufacturingOrderId && !facts.manufacturingOrder) return fail("manufacturingOrderId", "Tillverkningsordern finns inte");

  // The documents belong to the case's counterparty.
  if (facts.salesOrder && r.salesOrderId && facts.salesOrder.customerId !== r.customerId) {
    return fail("salesOrderId", `${facts.salesOrder.orderNumber} tillhör en annan kund`);
  }
  if (facts.invoice && r.invoiceId && facts.invoice.customerId !== r.customerId) {
    return fail("invoiceId", `${facts.invoice.invoiceNumber ?? "Fakturan"} tillhör en annan kund`);
  }
  if (facts.purchaseOrder && r.purchaseOrderId && facts.purchaseOrder.supplierId !== r.supplierId) {
    return fail("purchaseOrderId", `${facts.purchaseOrder.orderNumber} tillhör en annan leverantör`);
  }

  // The article is the chosen row's/TO's — filled in from the first one when
  // the case has none, and every chosen one must agree with it.
  const sources: { field: keyof DeviationLinkInput; articleId: string | null | undefined; text: string }[] = [
    { field: "salesOrderRowId", articleId: r.salesOrderRowId ? facts.salesOrderRow?.articleId : undefined, text: "kundorderradens" },
    { field: "purchaseOrderRowId", articleId: r.purchaseOrderRowId ? facts.purchaseOrderRow?.articleId : undefined, text: "inköpsorderradens" },
    { field: "manufacturingOrderId", articleId: r.manufacturingOrderId ? facts.manufacturingOrder?.articleId : undefined, text: "tillverkningsorderns" },
  ];
  for (const source of sources) {
    if (!source.articleId) continue;
    if (!r.articleId) r.articleId = source.articleId;
    else if (r.articleId !== source.articleId) {
      return fail(source.field, `Artikeln är inte ${source.text} artikel`);
    }
  }

  return { ok: true, resolved: r };
}

// Which case types a follow-up document may be linked to (the shortcuts'
// deviationId and Koppla dokument). A kreditfaktura or a replacement order
// answers a customer complaint, an IO or a leverantörsfaktura a supplier
// case, a TO (omarbete/ersättning) an internal case or a complaint.
export const LINK_DOCUMENT_CASE_TYPES: Record<DeviationLinkDocumentType, readonly DeviationType[]> = {
  credit_invoice: ["customer"],
  sales_order: ["customer"],
  purchase_order: ["supplier"],
  manufacturing_order: ["customer", "internal"],
  supplier_invoice: ["supplier"],
};

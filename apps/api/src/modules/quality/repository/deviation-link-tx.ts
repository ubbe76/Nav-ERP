import { eq, sql } from "drizzle-orm";
import {
  deviationEvents,
  deviationLinks,
  deviations,
  invoices,
  manufacturingOrders,
  purchaseOrders,
  salesOrders,
  supplierInvoices,
  type Db,
  type Tx,
} from "@navet/db";
import { DEVIATION_LINK_DOCUMENT_LABELS, DEVIATION_TYPE_LABELS, type DeviationLinkDocumentType } from "@navet/shared";
import { DeviationLinkNotAllowedError } from "../service/deviation-errors.js";
import { LINK_DOCUMENT_CASE_TYPES } from "../service/deviation-link-check.js";

// Avvikelser — the one way a follow-up document is linked to a case
// (deviation_links). A leaf with only schema imports, so the shortcuts in
// other modules can call it inside THEIR create transaction (Skapa
// kreditfaktura/ersättningsorder/inköpsorder/tillverkningsorder): the link
// commits or rolls back with the document. Koppla dokument goes the same way
// in its own transaction.
//
// The case is locked FOR UPDATE (the status check and the insert see the
// same status as Avsluta/Makulera, which update the row). Everything that
// refuses is DeviationLinkNotAllowedError (409 deviation-link-not-allowed):
// missing or closed/cancelled case, a document type that does not fit the
// case type, a missing document, another counterparty, already linked.

export interface LinkedDocumentFacts {
  number: string | null;
  customerId?: string | null;
  supplierId?: string | null;
  // credit_invoice: the invoice must be a credit note.
  invoiceType?: string;
}

// The facts of one follow-up document, or null when it does not exist.
export async function loadLinkedDocument(
  executor: Db | Tx,
  documentType: DeviationLinkDocumentType,
  documentId: string
): Promise<LinkedDocumentFacts | null> {
  switch (documentType) {
    case "credit_invoice": {
      const [row] = await executor
        .select({ number: invoices.invoiceNumber, customerId: invoices.customerId, invoiceType: invoices.type })
        .from(invoices)
        .where(eq(invoices.id, documentId));
      return row ?? null;
    }
    case "sales_order": {
      const [row] = await executor
        .select({ number: salesOrders.orderNumber, customerId: salesOrders.customerId })
        .from(salesOrders)
        .where(eq(salesOrders.id, documentId));
      return row ?? null;
    }
    case "purchase_order": {
      const [row] = await executor
        .select({ number: purchaseOrders.orderNumber, supplierId: purchaseOrders.supplierId })
        .from(purchaseOrders)
        .where(eq(purchaseOrders.id, documentId));
      return row ?? null;
    }
    case "manufacturing_order": {
      const [row] = await executor
        .select({ number: manufacturingOrders.orderNumber })
        .from(manufacturingOrders)
        .where(eq(manufacturingOrders.id, documentId));
      return row ?? null;
    }
    case "supplier_invoice": {
      const [row] = await executor
        .select({ number: supplierInvoices.registrationNumber, supplierId: supplierInvoices.supplierId })
        .from(supplierInvoices)
        .where(eq(supplierInvoices.id, documentId));
      return row ?? null;
    }
  }
}

export async function linkDeviationInTx(
  tx: Tx,
  input: { deviationId: string; documentType: DeviationLinkDocumentType; documentId: string; userId: string | null }
): Promise<{ linkId: string }> {
  const [deviation] = await tx
    .select({
      id: deviations.id,
      number: deviations.deviationNumber,
      type: deviations.type,
      status: deviations.status,
      customerId: deviations.customerId,
      supplierId: deviations.supplierId,
    })
    .from(deviations)
    .where(eq(deviations.id, input.deviationId))
    .for("update");
  if (!deviation) throw new DeviationLinkNotAllowedError("Avvikelsen finns inte");
  if (deviation.status !== "registered" && deviation.status !== "investigating") {
    throw new DeviationLinkNotAllowedError(`${deviation.number} är avslutad eller makulerad — inget kan kopplas till den`);
  }
  const label = DEVIATION_LINK_DOCUMENT_LABELS[input.documentType];
  if (!LINK_DOCUMENT_CASE_TYPES[input.documentType].includes(deviation.type)) {
    throw new DeviationLinkNotAllowedError(
      `En ${label.toLowerCase()} kan inte kopplas till en ${DEVIATION_TYPE_LABELS[deviation.type].toLowerCase()}`
    );
  }
  const document = await loadLinkedDocument(tx, input.documentType, input.documentId);
  if (!document) throw new DeviationLinkNotAllowedError(`${label} ${input.documentId} finns inte`);
  const name = document.number ?? label;
  if (input.documentType === "credit_invoice" && document.invoiceType !== "credit") {
    throw new DeviationLinkNotAllowedError(`${name} är ingen kreditfaktura`);
  }
  if (document.customerId !== undefined && document.customerId !== deviation.customerId) {
    throw new DeviationLinkNotAllowedError(`${name} tillhör en annan kund än ${deviation.number}`);
  }
  if (document.supplierId !== undefined && document.supplierId !== deviation.supplierId) {
    throw new DeviationLinkNotAllowedError(`${name} tillhör en annan leverantör än ${deviation.number}`);
  }

  const [link] = await tx
    .insert(deviationLinks)
    .values({ deviationId: deviation.id, documentType: input.documentType, documentId: input.documentId, createdBy: input.userId })
    .onConflictDoNothing()
    .returning({ id: deviationLinks.id });
  if (!link) throw new DeviationLinkNotAllowedError(`${name} är redan kopplad till ${deviation.number}`);
  await tx.insert(deviationEvents).values({
    deviationId: deviation.id,
    event: "link_added",
    detail: { linkId: link.id, documentType: input.documentType, documentId: input.documentId, documentNumber: document.number },
    userId: input.userId,
  });
  await tx.update(deviations).set({ updatedAt: sql`now()` }).where(eq(deviations.id, deviation.id));
  return { linkId: link.id };
}

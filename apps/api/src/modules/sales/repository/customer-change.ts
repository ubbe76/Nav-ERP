// Byt kund på en offert eller kundorder — the DB leaf. `loadCustomerChangeFacts`
// reads everything the pure plan (service/customer-change.ts) needs, on Db
// for the preview and on Tx under the locks for the change;
// `changeOrderCustomer` is the one transaction that writes.
//
// LOCK ORDER: the order's rows (sorted by id, FOR UPDATE) → the order (FOR
// UPDATE) — rows before the header like updateRow/deleteRow, deliverBatch,
// the markup repricing and the invoice's commit, so none of them can wait on
// us crosswise. addRow takes only the header (KEY SHARE): a row it committed
// between our row locks and our header lock is one we do not hold, so the
// rows are re-read under the header lock and another set than the locked one
// is `stale` (nothing written). FOR UPDATE on the rows (not NO KEY UPDATE)
// also makes an invoice row or a delivery row being linked to one of them
// (the FK's KEY SHARE) wait for us, and us for it.
//
// No price chain runs in here: the service planned outside (the chain reads
// on its own connections) and passes the plan with the basis it was made
// from; the facts are read again under the locks and must give that basis.
import { and, asc, eq, inArray, isNull, ne, or, sql } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import {
  articles,
  carriers,
  customerContacts,
  customerDeliveryAddresses,
  customers,
  deliveries,
  deliveryRows,
  deliveryTerms,
  deviationLinks,
  deviations,
  invoiceRows,
  invoices,
  paymentTerms,
  salesOrderRows,
  salesOrders,
  shipmentDeliveries,
  shipments,
  units,
  type Db,
  type Tx,
} from "@navet/db";
import type { CustomerChangePreview } from "@navet/shared";
import { documentKindSql } from "./document-kind.js";
import { customerChangeBasis, customerChangeBlockers, type CustomerChangeFacts } from "../service/customer-change.js";

function label(code: string | null, name: string | null) {
  if (!code && !name) return null;
  return [code, name].filter(Boolean).join(" · ");
}

export type CustomerChangeFactsResult =
  | { ok: true; facts: CustomerChangeFacts; customerActive: boolean }
  | { ok: false; reason: "order_not_found" | "customer_not_found" };

export async function loadCustomerChangeFacts(dbc: Db | Tx, orderId: string, customerId: string): Promise<CustomerChangeFactsResult> {
  const [order] = await dbc
    .select({
      id: salesOrders.id,
      orderNumber: salesOrders.orderNumber,
      documentKind: documentKindSql,
      status: salesOrders.status,
      customerId: salesOrders.customerId,
      customerNumber: customers.customerNumber,
      customerName: customers.name,
      currency: salesOrders.currency,
      exchangeRate: salesOrders.exchangeRate,
      generalMarkupPercent: salesOrders.generalMarkupPercent,
      materialMarkupPercent: salesOrders.materialMarkupPercent,
      customerOrderNumber: salesOrders.customerOrderNumber,
      customerInquiryNumber: salesOrders.customerInquiryNumber,
      deliveryAddressId: salesOrders.deliveryAddressId,
      deliveryAddressOneOff: customerDeliveryAddresses.oneOff,
      freightProductId: salesOrders.freightProductId,
      hasFreightQuote: sql<boolean>`${salesOrders.freightQuote} is not null`,
    })
    .from(salesOrders)
    .innerJoin(customers, eq(customers.id, salesOrders.customerId))
    .leftJoin(customerDeliveryAddresses, eq(customerDeliveryAddresses.id, salesOrders.deliveryAddressId))
    .where(eq(salesOrders.id, orderId));
  if (!order) return { ok: false, reason: "order_not_found" };

  // The new customer, with the customer that PAYS for it (Fakturakund,
  // migration 0230): the order's payment term is the paying customer's.
  const payers = alias(customers, "paying_customers");
  const [customer] = await dbc
    .select({
      id: customers.id,
      customerNumber: customers.customerNumber,
      name: customers.name,
      active: customers.active,
      currency: customers.currency,
      contactName: customers.contactName,
      deliveryTermId: customers.deliveryTermId,
      carrierId: customers.carrierId,
      deliveryTermCode: deliveryTerms.code,
      deliveryTermName: deliveryTerms.name,
      carrierCode: carriers.code,
      carrierName: carriers.name,
      invoiceCustomerId: customers.invoiceCustomerId,
      payerNumber: payers.customerNumber,
      payerName: payers.name,
      paymentTermId: sql<string | null>`case when ${payers.id} is null then ${customers.paymentTermId} else ${payers.paymentTermId} end`,
    })
    .from(customers)
    .leftJoin(payers, eq(payers.id, customers.invoiceCustomerId))
    .leftJoin(deliveryTerms, eq(deliveryTerms.id, customers.deliveryTermId))
    .leftJoin(carriers, eq(carriers.id, customers.carrierId))
    .where(eq(customers.id, customerId));
  if (!customer) return { ok: false, reason: "customer_not_found" };
  const [paymentTerm] = customer.paymentTermId
    ? await dbc.select({ code: paymentTerms.code, name: paymentTerms.name }).from(paymentTerms).where(eq(paymentTerms.id, customer.paymentTermId))
    : [];
  // Er referens: huvudkontakten, else the card's Kontaktperson.
  const [primaryContact] = await dbc
    .select({ name: customerContacts.name })
    .from(customerContacts)
    .where(and(eq(customerContacts.customerId, customerId), eq(customerContacts.isPrimary, true)));
  const reference = (primaryContact?.name ?? customer.contactName ?? "").trim().slice(0, 100);
  const [defaultAddress] = await dbc
    .select()
    .from(customerDeliveryAddresses)
    .where(
      and(eq(customerDeliveryAddresses.customerId, customerId), eq(customerDeliveryAddresses.isDefault, true), eq(customerDeliveryAddresses.oneOff, false))
    );

  const rowUnits = alias(units, "row_units");
  const rows = await dbc
    .select({
      rowId: salesOrderRows.id,
      articleId: salesOrderRows.articleId,
      articleNumber: articles.articleNumber,
      articleName: articles.name,
      quantity: salesOrderRows.quantityOrdered,
      quantityDelivered: salesOrderRows.quantityDelivered,
      unitPrice: salesOrderRows.unitPrice,
      discountPercent: salesOrderRows.discountPercent,
      priceOrigin: salesOrderRows.priceOrigin,
      unitCode: sql<string>`coalesce(${rowUnits.code}, ${units.code})`,
      unitFactor: salesOrderRows.unitFactor,
      configured: sql<boolean>`${salesOrderRows.configuration} is not null`,
      setupForRowId: salesOrderRows.setupForRowId,
    })
    .from(salesOrderRows)
    .innerJoin(articles, eq(articles.id, salesOrderRows.articleId))
    .innerJoin(units, eq(units.id, articles.unitId))
    .leftJoin(rowUnits, eq(rowUnits.id, salesOrderRows.unitId))
    .where(eq(salesOrderRows.salesOrderId, orderId))
    // The card's order (entry order).
    .orderBy(asc(salesOrderRows.createdAt), asc(salesOrderRows.id));
  const rowIds = rows.map((r) => r.rowId);

  // Leveranser: a live delivery row (an undone one is history, as an undone
  // receipt is for Byt leverantör).
  const [delivered] = await dbc
    .select({ n: sql<number>`count(*)::int` })
    .from(deliveryRows)
    .innerJoin(deliveries, eq(deliveries.id, deliveryRows.deliveryId))
    .where(and(eq(deliveries.salesOrderId, orderId), isNull(deliveryRows.undoneAt)));

  // Fakturor: an order row on an invoice row of an invoice that is not
  // cancelled — a draft is already the old customer's invoice, and a credit
  // note counts like the invoice it credits.
  const invoiceRowsFound =
    rowIds.length === 0
      ? []
      : await dbc
          .selectDistinct({ id: invoices.id, number: invoices.invoiceNumber })
          .from(invoiceRows)
          .innerJoin(invoices, eq(invoices.id, invoiceRows.invoiceId))
          .where(and(inArray(invoiceRows.salesOrderRowId, rowIds), ne(invoices.status, "cancelled")));

  // Försändelser: not cancelled, with a live link to one of the order's
  // följesedlar.
  const shipmentRows = await dbc
    .selectDistinct({ id: shipments.id, number: shipments.shipmentNumber })
    .from(shipments)
    .innerJoin(shipmentDeliveries, and(eq(shipmentDeliveries.shipmentId, shipments.id), eq(shipmentDeliveries.active, true)))
    .innerJoin(deliveries, eq(deliveries.id, shipmentDeliveries.deliveryId))
    .where(and(eq(deliveries.salesOrderId, orderId), ne(shipments.status, "cancelled")));

  // Reklamationer/avvikelser: a case names its customer — the column, the
  // row column and Koppla dokument all count, cancelled cases not.
  const deviationRows = await dbc
    .selectDistinct({ id: deviations.id, number: deviations.deviationNumber })
    .from(deviations)
    .leftJoin(
      deviationLinks,
      and(eq(deviationLinks.deviationId, deviations.id), eq(deviationLinks.documentType, "sales_order"), eq(deviationLinks.documentId, orderId))
    )
    .where(
      and(
        ne(deviations.status, "cancelled"),
        or(
          eq(deviations.salesOrderId, orderId),
          rowIds.length > 0 ? inArray(deviations.salesOrderRowId, rowIds) : sql`false`,
          sql`${deviationLinks.id} is not null`
        )
      )
    );

  const addressText = defaultAddress
    ? [defaultAddress.label, defaultAddress.address, [defaultAddress.postalCode, defaultAddress.city].filter(Boolean).join(" ")]
        .filter((part) => part && part.trim() !== "")
        .join(", ")
    : null;
  return {
    ok: true,
    customerActive: customer.active,
    facts: {
      order: {
        id: order.id,
        orderNumber: order.orderNumber,
        documentKind: order.documentKind,
        status: order.status,
        customerId: order.customerId,
        customerNumber: order.customerNumber,
        customerName: order.customerName,
        currency: order.currency,
        exchangeRate: Number(order.exchangeRate),
        generalMarkupPercent: order.generalMarkupPercent,
        materialMarkupPercent: order.materialMarkupPercent,
        customerOrderNumber: order.customerOrderNumber,
        customerInquiryNumber: order.customerInquiryNumber,
        deliveryAddressId: order.deliveryAddressId,
        deliveryAddressOneOff: order.deliveryAddressOneOff === true,
        hasFreightChoice: order.freightProductId !== null || order.hasFreightQuote,
      },
      customer: {
        id: customer.id,
        customerNumber: customer.customerNumber,
        name: customer.name,
        currency: customer.currency,
        deliveryTermId: customer.deliveryTermId,
        paymentTermId: customer.paymentTermId,
        carrierId: customer.carrierId,
        deliveryTerm: label(customer.deliveryTermCode, customer.deliveryTermName),
        paymentTerm: label(paymentTerm?.code ?? null, paymentTerm?.name ?? null),
        carrier: label(customer.carrierCode, customer.carrierName),
        customerReference: reference === "" ? null : reference,
        defaultDeliveryAddress: defaultAddress && addressText !== null ? { id: defaultAddress.id, text: addressText } : null,
        invoiceCustomer:
          customer.invoiceCustomerId && customer.payerNumber !== null && customer.payerName !== null
            ? { id: customer.invoiceCustomerId, customerNumber: customer.payerNumber, name: customer.payerName }
            : null,
      },
      rows: rows.map((r) => ({
        rowId: r.rowId,
        articleId: r.articleId,
        articleNumber: r.articleNumber,
        articleName: r.articleName,
        quantity: Number(r.quantity),
        quantityDelivered: Number(r.quantityDelivered),
        unitPrice: Number(r.unitPrice),
        discountPercent: Number(r.discountPercent),
        priceOrigin: r.priceOrigin,
        unitCode: r.unitCode,
        unitFactor: r.unitFactor === null ? null : Number(r.unitFactor),
        configured: r.configured,
        setupForRowId: r.setupForRowId,
      })),
      liveDeliveries: delivered?.n ?? 0,
      invoices: invoiceRowsFound.map((i) => i.number ?? "utkast").sort(),
      shipments: shipmentRows.map((s) => s.number).sort(),
      deviations: deviationRows.map((d) => d.number).sort(),
    },
  };
}

export type ChangeOrderCustomerResult =
  | { ok: true; revision: number }
  | { ok: false; reason: "order_not_found" | "customer_not_found" | "same_customer" }
  // The facts under the locks have blockers (status included).
  | { ok: false; reason: "blocked"; blockers: CustomerChangePreview["blockers"] }
  // The facts under the locks are not the ones the plan was made from —
  // nothing written.
  | { ok: false; reason: "stale" };

// `plan`: what the service planned outside (and compared with the client's
// `expected`); `basis`: customerChangeBasis of the facts it was planned from.
export async function changeOrderCustomer(
  db: Db,
  orderId: string,
  customerId: string,
  plan: CustomerChangePreview,
  basis: string
): Promise<ChangeOrderCustomerResult> {
  return db.transaction(async (tx): Promise<ChangeOrderCustomerResult> => {
    const locked = await tx
      .select({ id: salesOrderRows.id })
      .from(salesOrderRows)
      .where(eq(salesOrderRows.salesOrderId, orderId))
      .orderBy(asc(salesOrderRows.id))
      .for("update");
    const [order] = await tx.select({ id: salesOrders.id }).from(salesOrders).where(eq(salesOrders.id, orderId)).for("update");
    if (!order) return { ok: false, reason: "order_not_found" };

    // Everything again, under the locks.
    const loaded = await loadCustomerChangeFacts(tx, orderId, customerId);
    if (!loaded.ok) return loaded;
    const { facts } = loaded;
    if (facts.order.customerId === customerId) return { ok: false, reason: "same_customer" };
    const lockedIds = new Set(locked.map((r) => r.id));
    if (facts.rows.length !== lockedIds.size || facts.rows.some((r) => !lockedIds.has(r.rowId))) return { ok: false, reason: "stale" };
    const blockers = customerChangeBlockers(facts);
    if (blockers.length > 0) return { ok: false, reason: "blocked", blockers };
    if (customerChangeBasis(facts) !== basis) return { ok: false, reason: "stale" };

    for (const row of plan.rows) {
      if (
        row.after.unitPrice === row.before.unitPrice &&
        row.after.discountPercent === row.before.discountPercent &&
        row.after.priceOrigin === row.before.priceOrigin
      ) {
        continue;
      }
      await tx
        .update(salesOrderRows)
        .set({ unitPrice: String(row.after.unitPrice), discountPercent: String(row.after.discountPercent), priceOrigin: row.after.priceOrigin })
        .where(eq(salesOrderRows.id, row.rowId));
    }
    // As a new order to this customer: currency, terms, the förvalda
    // leveransadressen, Er referens and the Fakturakund. The old customer's
    // order and inquiry numbers and the freight choice (made for the old
    // address) are cleared. The status stays; the revision is bumped once.
    const [updated] = await tx
      .update(salesOrders)
      .set({
        customerId: facts.customer.id,
        invoiceCustomerId: facts.customer.invoiceCustomer?.id ?? null,
        currency: plan.to.currency,
        exchangeRate: String(plan.to.exchangeRate),
        deliveryAddressId: facts.customer.defaultDeliveryAddress?.id ?? null,
        deliveryTermId: facts.customer.deliveryTermId,
        paymentTermId: facts.customer.paymentTermId,
        carrierId: facts.customer.carrierId,
        customerReference: facts.customer.customerReference,
        customerOrderNumber: null,
        customerInquiryNumber: null,
        freightProductId: null,
        freightCarrierPrice: null,
        freightQuote: null,
        revision: sql`${salesOrders.revision} + 1`,
        updatedAt: new Date(),
      })
      .where(eq(salesOrders.id, orderId))
      .returning({ revision: salesOrders.revision });
    // The order's own engångsadress belonged to this order only — deleted
    // as when the header switches address (the NOT EXISTS keeps another
    // order that points at it, only possible through a bug, from losing it).
    const previous = facts.order.deliveryAddressId;
    if (previous) {
      await tx
        .delete(customerDeliveryAddresses)
        .where(
          and(
            eq(customerDeliveryAddresses.id, previous),
            eq(customerDeliveryAddresses.oneOff, true),
            sql`not exists (select 1 from ${salesOrders} where ${salesOrders.deliveryAddressId} = ${previous})`
          )
        );
    }
    return { ok: true, revision: updated!.revision };
  });
}

// Fakturakund (migration 0230) — the DB leaf. A customer may name another
// customer its invoices go to (customers.invoice_customer_id, the förval),
// and an order carries its own choice (sales_orders.invoice_customer_id,
// null = the ordering customer). EVERY reader of "who is this order billed
// to" goes through billToCustomerIdSql, so the invoice dialog, the
// collective run, the row guard and the freight can never disagree.
import { asc, eq, inArray, sql } from "drizzle-orm";
import { customers, salesOrders, type Db, type Tx } from "@navet/db";
import {
  CustomerIsInvoiceCustomerError,
  InvoiceCustomerHasInvoiceCustomerError,
  InvoiceCustomerInactiveError,
  InvoiceCustomerNotFoundError,
} from "../service/sales.errors.js";

// The customer an order is invoiced to: its fakturakund, else the orderer.
export const billToCustomerIdSql = sql<string>`coalesce(${salesOrders.invoiceCustomerId}, ${salesOrders.customerId})`;

export interface InvoiceCustomerChoice {
  id: string;
  customerNumber: string;
  name: string;
  active: boolean;
  invoiceCustomerId: string | null;
  paymentTermId: string | null;
}

// The customer as a fakturakund candidate — null when it does not exist.
export async function loadInvoiceCustomerChoice(dbc: Db | Tx, id: string): Promise<InvoiceCustomerChoice | null> {
  const [row] = await dbc
    .select({
      id: customers.id,
      customerNumber: customers.customerNumber,
      name: customers.name,
      active: customers.active,
      invoiceCustomerId: customers.invoiceCustomerId,
      paymentTermId: customers.paymentTermId,
    })
    .from(customers)
    .where(eq(customers.id, id));
  return row ?? null;
}

// What may be chosen as a fakturakund, on the card and on the order alike:
// it exists, is active and has no fakturakund of its own (no chain).
export function assertInvoiceCustomerSelectable(chosen: InvoiceCustomerChoice | null, id: string): asserts chosen is InvoiceCustomerChoice {
  if (!chosen) throw new InvoiceCustomerNotFoundError(id);
  if (!chosen.active) throw new InvoiceCustomerInactiveError(chosen.customerNumber);
  if (chosen.invoiceCustomerId !== null) throw new InvoiceCustomerHasInvoiceCustomerError(chosen.customerNumber);
}

// The customer card's choice, inside the customer's own write transaction.
// Both customer rows are locked in id order first (FOR NO KEY UPDATE — an
// order's FK check on either must not wait), so two concurrent saves that
// together would build a chain (A → B while B → C, or X → A while A → B)
// serialize on the shared row and the second one sees the first. `customerId`
// is null for a customer being created (nobody can point at it yet).
export async function assertInvoiceCustomerForCustomer(tx: Tx, customerId: string | null, invoiceCustomerId: string): Promise<void> {
  const ids = [...new Set([customerId, invoiceCustomerId].filter((id): id is string => id !== null))].sort();
  await tx.select({ id: customers.id }).from(customers).where(inArray(customers.id, ids)).orderBy(asc(customers.id)).for("no key update");
  assertInvoiceCustomerSelectable(await loadInvoiceCustomerChoice(tx, invoiceCustomerId), invoiceCustomerId);
  if (customerId === null) return;
  const pointing = await tx
    .select({ customerNumber: customers.customerNumber })
    .from(customers)
    .where(eq(customers.invoiceCustomerId, customerId))
    .orderBy(asc(customers.customerNumber))
    .limit(5);
  if (pointing.length > 0) throw new CustomerIsInvoiceCustomerError(pointing.map((c) => c.customerNumber));
}

// "Fakturakund åt" on the customer card: the customers that name this one.
export async function listInvoiceCustomerFor(dbc: Db | Tx, customerId: string) {
  return dbc
    .select({ id: customers.id, customerNumber: customers.customerNumber, name: customers.name })
    .from(customers)
    .where(eq(customers.invoiceCustomerId, customerId))
    .orderBy(asc(customers.customerNumber));
}

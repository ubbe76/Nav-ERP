import { and, asc, eq, gte, inArray, lte, sql } from "drizzle-orm";
import { customers, invoiceRows, invoices, vatCodes, type Db, type Tx } from "@navet/db";
import type { EuSalesLine } from "../service/periodic-summary.js";

// Periodisk sammanställning: every ISSUED customer invoice and credit note
// (issued or paid — never a draft or a cancelled draft) dated in the range,
// with the sum of its EUV and EUT rows per code. The buyer's number is the
// invoice's own snapshot (stamped at Utfärda); the customer's name and
// country are live — the country only decides a missing prefix on an older
// invoice.
export async function readEuSalesLines(executor: Db | Tx, from: string, to: string): Promise<EuSalesLine[]> {
  const rows = await executor
    .select({
      invoiceId: invoices.id,
      invoiceNumber: invoices.invoiceNumber,
      invoiceType: invoices.type,
      vatNumber: invoices.vatNumber,
      customerId: customers.id,
      customerName: customers.name,
      customerCountry: customers.country,
      code: vatCodes.code,
      amount: sql<string>`SUM(${invoiceRows.lineAmount})`,
    })
    .from(invoiceRows)
    .innerJoin(invoices, eq(invoices.id, invoiceRows.invoiceId))
    .innerJoin(vatCodes, eq(vatCodes.id, invoiceRows.vatCodeId))
    .innerJoin(customers, eq(customers.id, invoices.customerId))
    .where(
      and(
        inArray(invoices.status, ["issued", "paid"]),
        gte(invoices.invoiceDate, from),
        lte(invoices.invoiceDate, to),
        inArray(vatCodes.code, ["EUV", "EUT"])
      )
    )
    .groupBy(
      invoices.id,
      invoices.invoiceNumber,
      invoices.type,
      invoices.vatNumber,
      customers.id,
      customers.name,
      customers.country,
      vatCodes.code
    )
    .orderBy(asc(invoices.invoiceNumber), asc(vatCodes.code));

  return rows.map((row) => ({
    invoiceId: row.invoiceId,
    // Issued invoices always carry their FA number; the id is only a
    // defensive fallback for a hand-repaired row.
    invoiceNumber: row.invoiceNumber ?? row.invoiceId,
    invoiceType: row.invoiceType,
    vatNumber: row.vatNumber,
    customerId: row.customerId,
    customerName: row.customerName,
    customerCountry: row.customerCountry,
    code: row.code as EuSalesLine["code"],
    amount: row.amount,
  }));
}

import { and, asc, eq, inArray, isNull, lt, sql, type SQL } from "drizzle-orm";
import {
  customerPaymentRows,
  customerPayments,
  customers,
  invoiceReminders,
  invoices,
  lateInterestCharges,
  type Db,
  type Tx,
} from "@navet/db";
import { SEK } from "@navet/shared";

// Dröjsmålsränta — the DB leaf (Db | Tx throughout): what Räntefakturering's
// candidate list reads outside a transaction, Skapa räntefakturor re-reads
// under the source invoices' FOR UPDATE, and the invoice card / reminder PDF
// read for one invoice. Nothing here is a stored status:
//
//   * the CAPITAL is the invoice's gross (Σ rows, incl. VAT) minus the live
//     payment rows (applied + write-off, non-cancelled payments) — the same
//     source as open-amounts.ts, so the reskontra and the interest agree;
//     the påminnelseavgift is deliberately NOT capital;
//   * a charge is ACTIVE while its räntefaktura is not cancelled and not
//     fully credited (Σ issued/paid credit notes against it ≥ its gross).
//     A charge on a deleted draft row is gone (FK cascade).

// The invoices Räntefakturering may bill interest on: customer invoices
// (never credit notes) issued or paid, in SEK, whose customer has
// Dröjsmålsränta, and which are not themselves räntefakturor.
const CANDIDATE_CONDITIONS: SQL[] = [
  eq(invoices.type, "invoice"),
  inArray(invoices.status, ["issued", "paid"]),
  eq(invoices.currency, SEK),
  eq(customers.lateInterest, true),
  sql`NOT EXISTS (SELECT 1 FROM late_interest_charges lic WHERE lic.charge_invoice_id = ${invoices.id})`,
];

export type LateInterestSource = {
  invoiceId: string;
  invoiceNumber: string;
  customerId: string;
  customerName: string;
  customerPaymentTermId: string | null;
  privatePerson: boolean;
  customerLateFee: boolean;
  agreedRate: number | null;
  dueDate: string;
  // The gross incl. VAT — the capital before payments.
  principal: number;
};

// The candidate invoices: overdue per asOf (dueDate < asOf), optionally one
// customer's, or exactly the given ids (Skapa räntefakturor's re-check,
// which still applies every candidate condition — an invoice that stopped
// being one is a conflict there).
export async function listLateInterestSources(
  executor: Db | Tx,
  filter: { asOf: string; customerId?: string; invoiceIds?: string[] }
): Promise<LateInterestSource[]> {
  if (filter.invoiceIds && filter.invoiceIds.length === 0) return [];
  const conditions: SQL[] = [
    ...CANDIDATE_CONDITIONS,
    lt(invoices.dueDate, filter.asOf),
    ...(filter.customerId ? [eq(invoices.customerId, filter.customerId)] : []),
    ...(filter.invoiceIds ? [inArray(invoices.id, filter.invoiceIds)] : []),
  ];
  const rows = await executor
    .select({
      invoiceId: invoices.id,
      invoiceNumber: invoices.invoiceNumber,
      customerId: invoices.customerId,
      customerName: customers.name,
      customerPaymentTermId: customers.paymentTermId,
      privatePerson: customers.privatePerson,
      customerLateFee: customers.lateFee,
      agreedRate: customers.lateInterestRate,
      dueDate: invoices.dueDate,
      principal: sql<string>`COALESCE((SELECT SUM(ir.line_amount + ir.vat_amount) FROM invoice_rows ir WHERE ir.invoice_id = ${invoices.id}), 0)`,
    })
    .from(invoices)
    .innerJoin(customers, eq(customers.id, invoices.customerId))
    .where(and(...conditions))
    .orderBy(asc(customers.name), asc(invoices.dueDate), asc(invoices.invoiceNumber));
  return rows.map((row) => ({
    ...row,
    invoiceNumber: row.invoiceNumber ?? "",
    dueDate: row.dueDate!,
    agreedRate: row.agreedRate === null ? null : Number(row.agreedRate),
    principal: Number(row.principal),
  }));
}

// Row-locks the source invoices in id order — the serialization point of
// Skapa räntefakturor against a concurrent run (and against a payment on
// the same invoice, which takes the same lock).
export async function lockInvoices(tx: Tx, invoiceIds: string[]): Promise<void> {
  const ids = [...new Set(invoiceIds)].sort();
  if (ids.length === 0) return;
  await tx.select({ id: invoices.id }).from(invoices).where(inArray(invoices.id, ids)).orderBy(asc(invoices.id)).for("update");
}

// Live payment rows per invoice: the day and what it took off the capital.
export async function paymentsByInvoice(
  executor: Db | Tx,
  invoiceIds: string[]
): Promise<Map<string, { date: string; amount: number }[]>> {
  const out = new Map<string, { date: string; amount: number }[]>();
  if (invoiceIds.length === 0) return out;
  const rows = await executor
    .select({
      invoiceId: customerPaymentRows.invoiceId,
      date: customerPayments.paymentDate,
      amount: sql<string>`${customerPaymentRows.appliedAmount} + ${customerPaymentRows.writeOffAmount}`,
    })
    .from(customerPaymentRows)
    .innerJoin(customerPayments, eq(customerPayments.id, customerPaymentRows.paymentId))
    .where(and(isNull(customerPayments.cancelledAt), inArray(customerPaymentRows.invoiceId, invoiceIds)))
    .orderBy(asc(customerPayments.paymentDate));
  for (const row of rows) {
    const list = out.get(row.invoiceId) ?? [];
    list.push({ date: row.date, amount: Number(row.amount) });
    out.set(row.invoiceId, list);
  }
  return out;
}

// Σ påminnelseavgift per invoice (what the förseningsersättning is reduced by).
export async function reminderFeesByInvoice(executor: Db | Tx, invoiceIds: string[]): Promise<Map<string, number>> {
  const out = new Map<string, number>();
  if (invoiceIds.length === 0) return out;
  const rows = await executor
    .select({ invoiceId: invoiceReminders.invoiceId, total: sql<string>`SUM(${invoiceReminders.fee})` })
    .from(invoiceReminders)
    .where(inArray(invoiceReminders.invoiceId, invoiceIds))
    .groupBy(invoiceReminders.invoiceId);
  for (const row of rows) out.set(row.invoiceId, Number(row.total));
  return out;
}

export type LateInterestChargeRow = {
  id: string;
  invoiceId: string;
  fromDate: string | null;
  toDate: string | null;
  days: number;
  amount: number;
  fee: number;
  chargeInvoiceId: string;
  chargeInvoiceNumber: string | null;
  // Derived: the räntefaktura is not cancelled and not fully credited.
  active: boolean;
};

// Active = the räntefaktura (ci) is not cancelled and the issued/paid credit
// notes against it do not reach its gross. Written out by hand, like
// open-amounts.ts's subqueries, so the correlation never binds to the wrong
// table.
const chargeActiveSql = sql<boolean>`(
  ci.status <> 'cancelled'
  AND COALESCE((SELECT SUM(ir.line_amount + ir.vat_amount) FROM invoice_rows ir WHERE ir.invoice_id = ci.id), 0)
    > COALESCE((
        SELECT SUM(ir.line_amount + ir.vat_amount)
        FROM invoice_rows ir
        JOIN invoices cr ON cr.id = ir.invoice_id
        WHERE cr.credited_invoice_id = ci.id AND cr.status IN ('issued', 'paid')
      ), 0)
)`;

// Every charge made on the given SOURCE invoices, oldest first.
export async function chargesByInvoice(executor: Db | Tx, invoiceIds: string[]): Promise<Map<string, LateInterestChargeRow[]>> {
  const out = new Map<string, LateInterestChargeRow[]>();
  if (invoiceIds.length === 0) return out;
  const rows = await executor.execute(sql`
    SELECT c.id, c.invoice_id, c.from_date, c.to_date, c.days, c.amount, c.fee, c.charge_invoice_id,
           ci.invoice_number AS charge_invoice_number, ${chargeActiveSql} AS active
    FROM late_interest_charges c
    JOIN invoices ci ON ci.id = c.charge_invoice_id
    WHERE c.invoice_id IN (${sql.join(invoiceIds.map((id) => sql`${id}::uuid`), sql`, `)})
    ORDER BY c.created_at ASC, c.id ASC
  `);
  for (const raw of [...rows] as {
    id: string;
    invoice_id: string;
    from_date: string | null;
    to_date: string | null;
    days: number;
    amount: string;
    fee: string;
    charge_invoice_id: string;
    charge_invoice_number: string | null;
    active: boolean;
  }[]) {
    const list = out.get(raw.invoice_id) ?? [];
    list.push({
      id: raw.id,
      invoiceId: raw.invoice_id,
      fromDate: raw.from_date,
      toDate: raw.to_date,
      days: Number(raw.days),
      amount: Number(raw.amount),
      fee: Number(raw.fee),
      chargeInvoiceId: raw.charge_invoice_id,
      chargeInvoiceNumber: raw.charge_invoice_number,
      active: raw.active,
    });
    out.set(raw.invoice_id, list);
  }
  return out;
}

// Whether the invoice is itself a räntefaktura (carries charge rows).
export async function isLateInterestInvoice(executor: Db | Tx, invoiceId: string): Promise<boolean> {
  const [row] = await executor
    .select({ id: lateInterestCharges.id })
    .from(lateInterestCharges)
    .where(eq(lateInterestCharges.chargeInvoiceId, invoiceId))
    .limit(1);
  return row !== undefined;
}

export type LateInterestChargeWrite = {
  invoiceId: string;
  fromDate: string | null;
  toDate: string | null;
  days: number;
  amount: number;
  fee: number;
  chargeInvoiceId: string;
  chargeInvoiceRowId: string;
};

// createdAt one tick apart per row (the invoice rows' idiom): one INSERT
// shares now(), and the card lists charges in insertion order.
export async function insertCharges(tx: Tx, charges: LateInterestChargeWrite[], userId: string): Promise<void> {
  if (charges.length === 0) return;
  const now = Date.now();
  await tx.insert(lateInterestCharges).values(
    charges.map((charge, index) => ({
      invoiceId: charge.invoiceId,
      fromDate: charge.fromDate,
      toDate: charge.toDate,
      days: charge.days,
      amount: String(charge.amount),
      fee: String(charge.fee),
      chargeInvoiceId: charge.chargeInvoiceId,
      chargeInvoiceRowId: charge.chargeInvoiceRowId,
      createdBy: userId,
      createdAt: new Date(now + index),
    }))
  );
}

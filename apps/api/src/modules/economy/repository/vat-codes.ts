import { asc, eq, inArray, sql, type SQL } from "drizzle-orm";
import { vatCodes, type Db, type Tx } from "@navet/db";
import type { DomesticVatCode } from "@navet/shared";
import type { PostingVatCode } from "../service/verification-poster.js";
import { vatCodeBook, type VatCodeBook } from "../service/document-vat-code.js";

// Momskoder data access shared across modules (Db|Tx leaf, the same seam as
// readPostingSettings): the invoice issue and the supplier invoice approval
// load their rows' codes through their own transaction, and the insert paths
// translate a bare rate into its domestic code without a round trip.

// The columns PostingVatCode needs — spread into a select that joins
// vat_codes, so the posting reads the codes in the same query as the rows.
export const postingVatCodeColumns = {
  id: vatCodes.id,
  code: vatCodes.code,
  revenueAccount: vatCodes.revenueAccount,
  outputVatAccount: vatCodes.outputVatAccount,
  inputVatAccount: vatCodes.inputVatAccount,
  costAccount: vatCodes.costAccount,
  baseAccount: vatCodes.baseAccount,
  baseCounterAccount: vatCodes.baseCounterAccount,
};

export async function loadPostingVatCodes(executor: Db | Tx, ids: string[]): Promise<Map<string, PostingVatCode>> {
  const unique = [...new Set(ids)];
  if (unique.length === 0) return new Map();
  const rows = await executor.select(postingVatCodeColumns).from(vatCodes).where(inArray(vatCodes.id, unique));
  return new Map(rows.map((row) => [row.id, row] as const));
}

export async function listVatCodeRows(executor: Db | Tx) {
  return executor.select().from(vatCodes).orderBy(asc(vatCodes.code));
}

// Every code of the company as the documents need it (document-vat-code.ts).
export async function loadVatCodeBook(executor: Db | Tx): Promise<VatCodeBook> {
  const rows = await executor
    .select({ id: vatCodes.id, code: vatCodes.code, name: vatCodes.name, invoiceText: vatCodes.invoiceText, active: vatCodes.active })
    .from(vatCodes);
  return vatCodeBook(rows);
}

export async function findVatCodeRow(executor: Db | Tx, id: string) {
  const [row] = await executor.select().from(vatCodes).where(eq(vatCodes.id, id));
  return row ?? null;
}

// A domestic code's id as an SQL scalar for an INSERT/UPDATE value — the
// vat_codes rows always exist (seeded by migration 0142, never deleted).
export function domesticVatCodeIdSql(code: DomesticVatCode): SQL<string> {
  // Written out by hand: drizzle may render interpolated columns unqualified
  // inside another table's statement.
  return sql<string>`(select vc.id from vat_codes vc where vc.code = ${code})`;
}

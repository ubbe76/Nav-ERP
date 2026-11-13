import { and, eq } from "drizzle-orm";
import { supplierContacts, suppliers, type Db, type Tx } from "@navet/db";

// Leverantörens förval (migration 0217) — the ONE place a new inquiry or
// purchase order reads what the supplier card says about it. Every creation
// path (Ny inköpsorder, the behovsberäkning's Skapa ordrar, Behöver
// beställas, the lego purchase from the TO card, Skapa inköpsorder from an
// inquiry, Ny förfrågan) ends in the repository's create transaction, which
// calls this with its Tx. Works on Db or Tx like loadPriceBreaks.

export interface SupplierOrderDefaults {
  // Frakt på vårt konto (förval) on the supplier card.
  freightPaidByUs: boolean;
  // Er referens: the name of the supplier's huvudkontakt, null without one.
  yourReference: string | null;
  // The recipient of a sent purchase order: E-post för inköpsorder, else the
  // huvudkontakt's address, else the supplier's own E-post.
  purchaseOrderRecipient: string | null;
}

export async function loadSupplierOrderDefaults(dbc: Db | Tx, supplierId: string): Promise<SupplierOrderDefaults> {
  const [[supplier], [primary]] = await Promise.all([
    dbc
      .select({
        freightPaidByUsDefault: suppliers.freightPaidByUsDefault,
        purchaseOrderEmail: suppliers.purchaseOrderEmail,
        email: suppliers.email,
      })
      .from(suppliers)
      .where(eq(suppliers.id, supplierId)),
    dbc
      .select({ name: supplierContacts.name, email: supplierContacts.email })
      .from(supplierContacts)
      .where(and(eq(supplierContacts.supplierId, supplierId), eq(supplierContacts.isPrimary, true))),
  ]);
  return {
    freightPaidByUs: supplier?.freightPaidByUsDefault ?? false,
    yourReference: primary?.name.trim() || null,
    purchaseOrderRecipient: supplier?.purchaseOrderEmail || primary?.email || supplier?.email || null,
  };
}

// An explicit value in the call always wins over the supplier's förval.
// Er referens: omitted = the förval; "" is an explicit "none".
export function resolveOrderDefaults(
  defaults: SupplierOrderDefaults,
  explicit: { freightPaidByUs?: boolean; yourReference?: string | null }
): { freightPaidByUs: boolean; yourReference: string | null } {
  return {
    freightPaidByUs: explicit.freightPaidByUs ?? defaults.freightPaidByUs,
    // The column is varchar(100); a contact's name may be longer.
    yourReference: explicit.yourReference !== undefined ? explicit.yourReference || null : (defaults.yourReference?.slice(0, 100) ?? null),
  };
}

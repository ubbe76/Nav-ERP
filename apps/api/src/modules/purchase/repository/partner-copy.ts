// Kopiera leverantör till kund och tvärtom (packages/shared/src/partner-copy.ts):
// the supplier's side. supplierCopySource is what the supplier card hands to
// Kopiera till kund (the sales module reads it through SupplierCopyReader),
// insertSupplierCopyRelated what a supplier copied from a customer gets
// besides its own row — in the supplier's create transaction.
import { asc, desc, eq } from "drizzle-orm";
import { supplierContacts, supplierDeliveryAddresses, suppliers, type Db, type Tx } from "@navet/db";
import type { PartnerCopyContact, PartnerCopyDeliveryAddress, PartnerCopySource } from "@navet/shared";

export async function supplierCopySource(db: Db | Tx, supplierId: string): Promise<PartnerCopySource | null> {
  const [supplier] = await db.select().from(suppliers).where(eq(suppliers.id, supplierId));
  if (!supplier) return null;
  const [contacts, deliveryAddresses] = await Promise.all([
    db
      .select({
        name: supplierContacts.name,
        phone: supplierContacts.phone,
        mobile: supplierContacts.mobile,
        email: supplierContacts.email,
        comment: supplierContacts.comment,
        isPrimary: supplierContacts.isPrimary,
      })
      .from(supplierContacts)
      .where(eq(supplierContacts.supplierId, supplierId))
      .orderBy(desc(supplierContacts.isPrimary), asc(supplierContacts.name), asc(supplierContacts.id)),
    db
      .select({
        label: supplierDeliveryAddresses.label,
        address: supplierDeliveryAddresses.address,
        postalCode: supplierDeliveryAddresses.postalCode,
        city: supplierDeliveryAddresses.city,
        isDefault: supplierDeliveryAddresses.isDefault,
      })
      .from(supplierDeliveryAddresses)
      .where(eq(supplierDeliveryAddresses.supplierId, supplierId))
      .orderBy(desc(supplierDeliveryAddresses.isDefault), asc(supplierDeliveryAddresses.label), asc(supplierDeliveryAddresses.id)),
  ]);
  return {
    id: supplier.id,
    number: supplier.supplierNumber,
    name: supplier.name,
    contactName: supplier.contactName,
    email: supplier.email,
    phone: supplier.phone,
    address: supplier.address,
    postalCode: supplier.postalCode,
    city: supplier.city,
    country: supplier.country,
    orgNumber: supplier.orgNumber,
    vatNumber: supplier.vatNumber,
    currency: supplier.currency,
    language: supplier.language,
    contacts,
    // A supplier's delivery address has no country of its own.
    deliveryAddresses: deliveryAddresses.map((a) => ({ ...a, country: null })),
  };
}

// The copied contacts and delivery addresses of a NEW supplier: the source
// has at most one primary contact and one default address, so nothing needs
// demoting. A supplier's address has no country column — a customer
// address's country stays behind.
export interface SupplierCopyRelated {
  contacts: PartnerCopyContact[];
  deliveryAddresses: PartnerCopyDeliveryAddress[];
}

export async function insertSupplierCopyRelated(tx: Tx, supplierId: string, related: SupplierCopyRelated) {
  if (related.contacts.length > 0) {
    await tx.insert(supplierContacts).values(related.contacts.map((c) => ({ ...c, supplierId })));
  }
  if (related.deliveryAddresses.length > 0) {
    await tx.insert(supplierDeliveryAddresses).values(
      related.deliveryAddresses.map(({ label, address, postalCode, city, isDefault }) => ({ label, address, postalCode, city, isDefault, supplierId }))
    );
  }
}

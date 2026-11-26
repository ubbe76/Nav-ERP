// Kopiera leverantör till kund och tvärtom (packages/shared/src/partner-copy.ts):
// the customer's side. customerCopySource is what the customer card hands to
// Kopiera till leverantör (the purchase module reads it through
// CustomerCopyReader), insertCustomerCopyRelated what a customer copied from
// a supplier gets besides its own row — in the customer's create transaction.
import { and, asc, desc, eq } from "drizzle-orm";
import { customerContacts, customerDeliveryAddresses, customers, type Db, type Tx } from "@navet/db";
import type { PartnerCopyContact, PartnerCopyDeliveryAddress, PartnerCopySource } from "@navet/shared";

export async function customerCopySource(db: Db | Tx, customerId: string): Promise<PartnerCopySource | null> {
  const [customer] = await db.select().from(customers).where(eq(customers.id, customerId));
  if (!customer) return null;
  const [contacts, deliveryAddresses] = await Promise.all([
    db
      .select({
        name: customerContacts.name,
        phone: customerContacts.phone,
        mobile: customerContacts.mobile,
        email: customerContacts.email,
        comment: customerContacts.comment,
        isPrimary: customerContacts.isPrimary,
      })
      .from(customerContacts)
      .where(eq(customerContacts.customerId, customerId))
      .orderBy(desc(customerContacts.isPrimary), asc(customerContacts.name), asc(customerContacts.id)),
    // Engångsadresser belong to one order, not to the customer.
    db
      .select({
        label: customerDeliveryAddresses.label,
        address: customerDeliveryAddresses.address,
        postalCode: customerDeliveryAddresses.postalCode,
        city: customerDeliveryAddresses.city,
        country: customerDeliveryAddresses.country,
        isDefault: customerDeliveryAddresses.isDefault,
      })
      .from(customerDeliveryAddresses)
      .where(and(eq(customerDeliveryAddresses.customerId, customerId), eq(customerDeliveryAddresses.oneOff, false)))
      .orderBy(desc(customerDeliveryAddresses.isDefault), asc(customerDeliveryAddresses.label), asc(customerDeliveryAddresses.id)),
  ]);
  return {
    id: customer.id,
    number: customer.customerNumber,
    name: customer.name,
    contactName: customer.contactName,
    email: customer.email,
    phone: customer.phone,
    address: customer.address,
    postalCode: customer.postalCode,
    city: customer.city,
    country: customer.country,
    orgNumber: customer.orgNumber,
    vatNumber: customer.vatNumber,
    currency: customer.currency,
    language: customer.language,
    contacts,
    deliveryAddresses,
  };
}

// The copied contacts and delivery addresses of a NEW customer: the source
// has at most one primary contact and one default address (its partial
// unique indexes), so nothing needs demoting.
export interface CustomerCopyRelated {
  contacts: PartnerCopyContact[];
  deliveryAddresses: Array<PartnerCopyDeliveryAddress & { country: string }>;
}

export async function insertCustomerCopyRelated(tx: Tx, customerId: string, related: CustomerCopyRelated) {
  if (related.contacts.length > 0) {
    await tx.insert(customerContacts).values(related.contacts.map((c) => ({ ...c, customerId })));
  }
  if (related.deliveryAddresses.length > 0) {
    await tx.insert(customerDeliveryAddresses).values(related.deliveryAddresses.map((a) => ({ ...a, customerId })));
  }
}

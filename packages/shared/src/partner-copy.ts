import { z } from "zod";

// Kopiera leverantör till kund och tvärtom (2026-11-26, the user: "en
// funktion att kopiera en leverantör till kund och tvärtom inne från
// Leverantörer och Kunder"). Kopiera till kund on the supplier card and
// Kopiera till leverantör on the customer card create a NEW partner on the
// other side from the card's own data — a one-time copy, no link is kept.
//
// What goes across is what describes the company itself, the same on both
// sides: name, address, organisations-/momsnummer, contact details, currency,
// language, the contacts and the delivery addresses (the partner's places to
// receive goods on both sides). What describes the business in ONE direction
// stays: the terms (leverans-/betalningsvillkor, speditör and our account
// with it), fixed delivery days, prices and markups, bank details, Vårt
// kundnummer/leverantörsnummer and the invoice address. partnerCopyFields is
// the one rule both directions use.

// The number of the new partner — omitted = the next in its number series.
export const copySupplierToCustomerSchema = z
  .object({
    supplierId: z.string().uuid(),
    customerNumber: z.string().trim().min(1).max(50).optional(),
  })
  .strict();
export type CopySupplierToCustomerInput = z.infer<typeof copySupplierToCustomerSchema>;

export const copyCustomerToSupplierSchema = z
  .object({
    customerId: z.string().uuid(),
    supplierNumber: z.string().trim().min(1).max(50).optional(),
  })
  .strict();
export type CopyCustomerToSupplierInput = z.infer<typeof copyCustomerToSupplierSchema>;

export interface PartnerCopyContact {
  name: string;
  phone: string | null;
  mobile: string | null;
  email: string | null;
  comment: string | null;
  isPrimary: boolean;
}

export interface PartnerCopyDeliveryAddress {
  label: string;
  address: string;
  postalCode: string | null;
  city: string | null;
  // A customer's address has its own country; a supplier's has none (null).
  country: string | null;
  isDefault: boolean;
}

// What a partner card hands over, read by its own module.
export interface PartnerCopySource {
  id: string;
  number: string;
  name: string;
  contactName: string | null;
  email: string | null;
  phone: string | null;
  address: string | null;
  postalCode: string | null;
  city: string | null;
  country: string;
  orgNumber: string | null;
  vatNumber: string | null;
  currency: string;
  language: string;
  contacts: PartnerCopyContact[];
  deliveryAddresses: PartnerCopyDeliveryAddress[];
}

// The new partner's own fields — the input of createCustomerSchema /
// createSupplierSchema, which parse it (their defaults for everything else).
// Empty text is left out, as the forms send it.
export function partnerCopyFields(source: PartnerCopySource) {
  const text = (value: string | null) => (value !== null && value.trim() !== "" ? value : undefined);
  return {
    name: source.name,
    contactName: text(source.contactName),
    email: text(source.email),
    phone: text(source.phone),
    address: text(source.address),
    postalCode: text(source.postalCode),
    city: text(source.city),
    country: source.country,
    orgNumber: text(source.orgNumber),
    vatNumber: text(source.vatNumber),
    currency: source.currency,
    language: source.language,
  };
}

// The delivery addresses on the new partner. A supplier's addresses have no
// country of their own, so on a customer they get the supplier's country —
// more often right for a supplier abroad than SE.
export function partnerCopyDeliveryAddresses(source: PartnerCopySource): Array<PartnerCopyDeliveryAddress & { country: string }> {
  return source.deliveryAddresses.map((a) => ({ ...a, country: a.country ?? source.country }));
}

// Mottagarens förifyllning — pure. Address: the order's leveransadress, else
// the customer's förvalda leveransadress, else the besöksadress. Contact: the
// customer's huvudkontakt, falling back field by field to the customer.

export interface AddressSource {
  address: string;
  postalCode: string | null;
  city: string | null;
  country: string;
}

export interface RecipientSource {
  customer: {
    name: string;
    address: string | null;
    postalCode: string | null;
    city: string | null;
    country: string;
    phone: string | null;
    email: string | null;
    privatePerson: boolean;
  };
  orderAddress: AddressSource | null;
  defaultAddress: AddressSource | null;
  primaryContact: { name: string; phone: string | null; mobile: string | null; email: string | null } | null;
  order: { customerOrderNumber: string | null; customerReference: string | null };
}

export interface RecipientFields {
  recipientName: string;
  recipientAddressLine1: string | null;
  recipientAddressLine2: string | null;
  recipientPostalCode: string | null;
  recipientCity: string | null;
  recipientCountry: string;
  recipientContactName: string | null;
  recipientPhone: string | null;
  recipientEmail: string | null;
  recipientPrivatePerson: boolean;
  receiverReference: string | null;
}

const cut = (value: string | null, max: number) => (value === null ? null : value.slice(0, max));
const blankToNull = (value: string | null | undefined) => (value && value.trim() !== "" ? value.trim() : null);

// Address fields are free text and may span lines: first line → line 1, the
// rest joined into line 2.
export function splitAddress(text: string | null): [string | null, string | null] {
  const lines = (text ?? "")
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l !== "");
  if (lines.length === 0) return [null, null];
  return [cut(lines[0]!, 255), lines.length > 1 ? cut(lines.slice(1).join(", "), 255) : null];
}

export function resolveRecipient(source: RecipientSource): RecipientFields {
  const { customer, primaryContact } = source;
  const address: AddressSource | null =
    source.orderAddress ??
    source.defaultAddress ??
    (customer.address
      ? { address: customer.address, postalCode: customer.postalCode, city: customer.city, country: customer.country }
      : null);
  const [line1, line2] = splitAddress(address?.address ?? null);
  return {
    recipientName: customer.name.slice(0, 255),
    recipientAddressLine1: line1,
    recipientAddressLine2: line2,
    recipientPostalCode: blankToNull(address?.postalCode),
    recipientCity: blankToNull(address?.city),
    recipientCountry: address?.country ?? customer.country ?? "SE",
    recipientContactName: blankToNull(primaryContact?.name),
    recipientPhone: blankToNull(primaryContact?.phone) ?? blankToNull(primaryContact?.mobile) ?? blankToNull(customer.phone),
    recipientEmail: blankToNull(primaryContact?.email) ?? blankToNull(customer.email),
    recipientPrivatePerson: customer.privatePerson,
    receiverReference: cut(
      blankToNull(source.order.customerOrderNumber) ?? blankToNull(source.order.customerReference),
      100
    ),
  };
}

// Avsändarens referens: the följesedel numbers, sorted, comma separated.
export function senderReferenceFor(deliveryNumbers: string[]): string | null {
  if (deliveryNumbers.length === 0) return null;
  return [...deliveryNumbers].sort().join(", ").slice(0, 100);
}

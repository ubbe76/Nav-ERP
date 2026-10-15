// What the carriers need before Sendify is called — checked by us first so
// the user gets one clear Swedish list instead of Sendify's field errors.

export interface PartyFields {
  recipientName: string | null;
  recipientAddressLine1: string | null;
  recipientPostalCode: string | null;
  recipientCity: string | null;
  recipientCountry: string | null;
  recipientPhone: string | null;
  recipientEmail: string | null;
  senderName: string | null;
  senderAddressLine1: string | null;
  senderPostalCode: string | null;
  senderCity: string | null;
  senderCountry: string | null;
  senderPhone: string | null;
  senderEmail: string | null;
}

interface Party {
  name: string | null;
  address: string | null;
  postalCode: string | null;
  city: string | null;
  country: string | null;
  phone: string | null;
  email: string | null;
}

const blank = (v: string | null) => v === null || v.trim() === "";

function party(label: string, p: Party): string[] {
  const missing: string[] = [];
  if (blank(p.name)) missing.push(`${label}: namn`);
  if (blank(p.address)) missing.push(`${label}: adress`);
  if (blank(p.postalCode)) missing.push(`${label}: postnummer`);
  if (blank(p.city)) missing.push(`${label}: ort`);
  if (blank(p.country)) missing.push(`${label}: land`);
  if (blank(p.phone) && blank(p.email)) missing.push(`${label}: telefon eller e-post`);
  return missing;
}

export function missingForBooking(shipment: PartyFields, parcels: { weightKg: number }[]): string[] {
  const missing = [
    ...party("Mottagare", {
      name: shipment.recipientName,
      address: shipment.recipientAddressLine1,
      postalCode: shipment.recipientPostalCode,
      city: shipment.recipientCity,
      country: shipment.recipientCountry,
      phone: shipment.recipientPhone,
      email: shipment.recipientEmail,
    }),
    ...party("Avsändare", {
      name: shipment.senderName,
      address: shipment.senderAddressLine1,
      postalCode: shipment.senderPostalCode,
      city: shipment.senderCity,
      country: shipment.senderCountry,
      phone: shipment.senderPhone,
      email: shipment.senderEmail,
    }),
  ];
  if (parcels.length === 0) missing.push("Minst ett kolli");
  parcels.forEach((p, i) => {
    if (!(p.weightKg > 0)) missing.push(`Kolli ${i + 1}: vikt`);
  });
  return missing;
}
